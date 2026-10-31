import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { type Config, defaults } from "./config.ts";
import { type Runner, run } from "./exec.ts";
import { gitCommit, gitPr, gitPush, type PrInput } from "./pr.ts";
import type { Step } from "./switch.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-git-pr-")));
const origin = join(root, "origin.git");
const main = join(root, "main");
const hooks = join(root, "hooks");
const bin = join(root, "bin");
const ghLog = join(root, "gh.log");
const helperLog = join(root, "helper.log");

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function script(path: string, text: string): string {
  writeFileSync(path, `#!/bin/sh\n${text}`);
  chmodSync(path, 0o755);
  return path;
}

beforeAll(() => {
  // Only this test's git config: no variables of a calling hook, no global hooks, a fixed identity.
  for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];
  const gitconfig = join(root, "gitconfig");
  writeFileSync(gitconfig, "[user]\n\tname = t\n\temail = t@t\n[init]\n\tdefaultBranch = main\n");
  process.env.GIT_CONFIG_GLOBAL = gitconfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";

  mkdirSync(hooks);
  mkdirSync(bin);
  script(
    join(hooks, "pre-commit"),
    'if [ -n "$PI_GIT_SWITCH" ]; then echo "the hard stop sees PI_GIT_SWITCH" >&2; exit 1; fi\nif git diff --cached | grep -q BAD; then echo "lint: BAD found" >&2; exit 1; fi\n',
  );
  script(
    join(hooks, "commit-msg"),
    'head -1 "$1" | grep -q "^feat: " || { echo "commit-msg: use feat: <subject>" >&2; exit 1; }\n',
  );
  script(
    join(hooks, "pre-push"),
    'if grep -q FAIL push.txt 2>/dev/null; then echo "check: push.txt says FAIL" >&2; exit 1; fi\n',
  );

  // The helper: answers by task, fixes by stage, and logs each call.
  script(
    join(bin, "pi"),
    `for last; do :; done
input=$(cat)
echo "$PI_GIT_HELPER|$last" | head -1 >> "${helperLog}"
echo "$input" >> "${helperLog}.input"
case "$PI_GIT_HELPER" in
  fix)
    case "$input" in
      *CANTFIX*) echo "CANNOT FIX: the intent forbids it" ;;
      *"pre-commit checks"*) sed -i 's/BAD/GOOD/' bad.txt; echo "Replaced BAD with GOOD in bad.txt." ;;
      *"pre-push checks"*) echo OK > push.txt; echo "Set push.txt to OK." ;;
    esac ;;
  answer)
    case "$input$last" in
      *BADMSG*) echo '{"subject": "nope", "body": ""}' ;;
      *"commit-msg hook rejected"*) echo '{"subject": "feat: add the thing", "body": "Needed for the test."}' ;;
      *"commit message"*) echo 'Here: {"subject": "add the thing", "body": ""}' ;;
      *"pull request"*) printf '\`\`\`json\\n{"title": "feat: add the thing", "body": "## What\\\\nThe thing."}\\n\`\`\`\\n' ;;
    esac ;;
esac
`,
  );
  // gh: no open PR unless gh.pr says so; pr create prints a URL.
  script(
    join(bin, "gh"),
    `echo "$*" >> "${ghLog}"
case "$1 $2" in
  "pr view") view="${root}/gh.view.$(echo "$3" | tr / _)"
    if [ -f "$view" ]; then cat "$view"; elif [ -f "${root}/gh.pr" ]; then cat "${root}/gh.pr"; else exit 1; fi ;;
  "pr create") if [ -f "${root}/gh.fail" ]; then echo "create refused" >&2; exit 1; fi; echo "https://github.com/owner/repo/pull/7" ;;
  "pr edit") if [ -f "${root}/gh.fail" ]; then echo "edit refused" >&2; exit 1; fi ;;
  *) exit 1 ;;
esac
`,
  );

  execFileSync("git", ["init", "-q", "--bare", origin]);
  execFileSync("git", ["clone", "-q", origin, main]);
  writeFileSync(join(main, "README.md"), "# repo\n");
  sh(main, "add", "-A");
  sh(main, "commit", "-q", "-m", "feat: start");
  sh(main, "push", "-q", "origin", "main");
  sh(main, "remote", "set-head", "origin", "main");
  sh(main, "config", "core.hooksPath", hooks);
});

let config: Config;
let worktree: string;
let counter = 0;
const steps: string[] = [];
const runner: Runner = (command, args, options) => run(command === "gh" ? join(bin, "gh") : command, args, options);

beforeEach(() => {
  counter++;
  worktree = join(root, "worktrees", `topic-${counter}`);
  sh(main, "worktree", "add", "-q", "-b", `feat/topic-${counter}`, worktree, "origin/main");
  config = { ...defaults(join(root, "pi-git.json"), {}, root), pi: join(bin, "pi"), attempts: 2 };
  writeFileSync(ghLog, "");
  writeFileSync(helperLog, "");
  writeFileSync(join(root, "gh.pr"), "");
  execFileSync("rm", ["-f", join(root, "gh.pr"), join(root, "gh.fail")]);
  steps.length = 0;
});

const pr = (input: Partial<PrInput> = {}) =>
  gitPr(
    { path: worktree, intent: "Add the thing.", ...input },
    { run: runner, config, progress: (step) => steps.push(step) },
  );

describe("gitPr", () => {
  test("fixes the checks, writes message and PR, pushes and opens the PR", async () => {
    writeFileSync(join(worktree, "bad.txt"), "BAD\n");
    writeFileSync(join(worktree, "push.txt"), "FAIL\n");
    const result = await pr();

    expect(result.summary).toContain("Opened PR #7: https://github.com/owner/repo/pull/7");
    expect(result.ok).toBe(true);
    expect(result.pr).toEqual({ number: 7, url: "https://github.com/owner/repo/pull/7", created: true });
    expect(result.commit?.subject).toBe("feat: add the thing");
    expect(result.notes).toEqual(["pre-commit: Replaced BAD with GOOD in bad.txt.", "pre-push: Set push.txt to OK."]);

    // One commit, amended with the pre-push fix, on GitHub.
    const branch = `feat/topic-${counter}`;
    expect(sh(origin, "log", "--format=%s", `main..${branch}`)).toBe("feat: add the thing");
    expect(sh(origin, "show", `${branch}:bad.txt`)).toBe("GOOD");
    expect(sh(origin, "show", `${branch}:push.txt`)).toBe("OK");
    expect(sh(origin, "log", "-1", "--format=%b", branch)).toBe("Needed for the test.");

    const gh = readFileSync(ghLog, "utf8");
    expect(gh).toContain(`pr create --base main --head ${branch} --title feat: add the thing --body-file`);
    expect(steps).toContain("pre-commit: checks fail; the helper fixes them (attempt 1/2)");
    const helper = readFileSync(helperLog, "utf8");
    expect(helper).toMatch(/^fix\|/m);
    expect(helper).toMatch(/^answer\|/m);
  });

  test("a draft PR", async () => {
    writeFileSync(join(worktree, "a.txt"), "a\n");
    const result = await pr({ draft: true });
    expect(result.summary).toContain("Opened PR #7 (draft)");
    expect(readFileSync(ghLog, "utf8")).toMatch(/--draft/);
  });

  test("updates the open PR instead of opening one", async () => {
    writeFileSync(
      join(root, "gh.pr"),
      JSON.stringify({ number: 3, url: "https://x/pull/3", title: "t", body: "b", baseRefName: "main", state: "OPEN" }),
    );
    writeFileSync(join(worktree, "a.txt"), "a\n");
    const result = await pr();
    expect(result.summary).toContain("Updated PR #3: https://x/pull/3");
    expect(readFileSync(ghLog, "utf8")).toContain("pr edit 3 --title feat: add the thing --body-file");
  });

  test("pushes commits that are already there", async () => {
    writeFileSync(join(worktree, "a.txt"), "a\n");
    sh(worktree, "add", "-A");
    sh(worktree, "commit", "-q", "-m", "feat: by hand");
    const result = await pr();
    expect(result.ok).toBe(true);
    expect(result.commit).toBeUndefined();
    expect(result.summary).toContain(`Pushed feat/topic-${counter}; the local checks passed.`);
  });

  test("rebases on commits that appeared on GitHub", async () => {
    const branch = `feat/topic-${counter}`;
    writeFileSync(join(worktree, "a.txt"), "a\n");
    sh(worktree, "add", "-A");
    sh(worktree, "commit", "-q", "-m", "feat: first");
    sh(worktree, "push", "-q", "-u", "origin", branch);
    // Someone (the watcher) adds a commit on GitHub.
    const other = join(root, `other-${counter}`);
    execFileSync("git", ["clone", "-q", "-b", branch, origin, other]);
    writeFileSync(join(other, "b.txt"), "b\n");
    sh(other, "add", "-A");
    sh(other, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "feat: remote");
    sh(other, "push", "-q");

    writeFileSync(join(worktree, "c.txt"), "c\n");
    const result = await pr();
    expect(result.ok).toBe(true);
    expect(steps).toContain("the branch on GitHub moved; rebasing on it");
    expect(sh(origin, "log", "--format=%s", `main..${branch}`).split("\n")).toEqual([
      "feat: add the thing",
      "feat: remote",
      "feat: first",
    ]);
  });

  test("stops when the helper cannot fix, with the changes staged", async () => {
    writeFileSync(join(worktree, "bad.txt"), "BAD\n");
    const result = await pr({ intent: "CANTFIX on purpose." });
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/^git_pr stopped: The pre-commit checks still fail:/);
    expect(result.summary).toContain("CANNOT FIX: the intent forbids it");
    expect(result.summary).toContain("nothing was pushed");
    expect(sh(worktree, "diff", "--cached", "--name-only")).toBe("bad.txt");
  });

  test("nothing to do", async () => {
    const result = await pr();
    expect(result.summary).toMatch(/nothing to do: no changes/);
  });

  test("refuses the main checkout and a detached HEAD", async () => {
    expect((await pr({ path: main })).summary).toContain("is the main checkout. Work in a worktree");
    sh(worktree, "switch", "-q", "--detach");
    expect((await pr()).summary).toContain("has a detached HEAD");
    expect((await pr({ path: root })).summary).toContain("is not in a git repository");
  });

  test("an unknown base cannot be fetched", async () => {
    writeFileSync(join(worktree, "a.txt"), "a\n");
    expect((await pr({ base: "nope" })).summary).toContain("git fetch origin nope failed");
  });
  test("stops when every commit message is rejected", async () => {
    writeFileSync(join(worktree, "a.txt"), "a\n");
    const result = await pr({ intent: "BADMSG" });
    expect(result.summary).toContain("No commit message: the commit-msg hook rejected every message the helper wrote");
  });

  test("a fix after the commit is on GitHub becomes a new commit", async () => {
    const branch = `feat/topic-${counter}`;
    writeFileSync(join(worktree, "push.txt"), "FAIL\n");
    sh(worktree, "add", "-A");
    sh(worktree, "commit", "-q", "-m", "feat: by hand");
    sh(worktree, "-c", "core.hooksPath=/dev/null", "push", "-q", "origin", `HEAD:refs/heads/backup-${counter}`);
    const result = await pr();
    expect(result.ok).toBe(true);
    expect(sh(origin, "log", "--format=%s", `main..${branch}`).split("\n")).toEqual([
      "feat: add the thing",
      "feat: by hand",
    ]);
  });

  test("stops when the branch on GitHub conflicts", async () => {
    const branch = `feat/topic-${counter}`;
    writeFileSync(join(worktree, "a.txt"), "mine\n");
    sh(worktree, "add", "-A");
    sh(worktree, "commit", "-q", "-m", "feat: mine");
    const other = join(root, `other-${counter}`);
    execFileSync("git", ["clone", "-q", origin, other]);
    sh(other, "switch", "-q", "-c", branch);
    writeFileSync(join(other, "a.txt"), "theirs\n");
    sh(other, "add", "-A");
    sh(other, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "feat: theirs");
    sh(other, "push", "-q", "origin", branch);
    const result = await pr();
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("The branch on GitHub has commits that conflict with this worktree.");
    expect(sh(worktree, "status", "--porcelain")).toBe("");
  });

  test("reports gh failures", async () => {
    writeFileSync(join(root, "gh.fail"), "");
    writeFileSync(join(worktree, "a.txt"), "a\n");
    expect((await pr()).summary).toContain("gh pr create failed:\ncreate refused");
    writeFileSync(
      join(root, "gh.pr"),
      JSON.stringify({ number: 3, url: "u", title: "t", body: "b", baseRefName: "main", state: "OPEN" }),
    );
    expect((await pr()).summary).toContain("gh pr edit failed:\nedit refused");
  });
  test("for the watcher: push without touching the PR", async () => {
    writeFileSync(join(worktree, "a.txt"), "a\n");
    const result = await pr({ updatePr: false });
    expect(result).toMatchObject({ ok: true, summary: `Pushed feat/topic-${counter}.` });
    expect(readFileSync(ghLog, "utf8")).not.toContain("pr create");
  });

  test("for the watcher: a force-push with a lease after a rebase", async () => {
    const branch = `feat/topic-${counter}`;
    writeFileSync(join(worktree, "a.txt"), "a\n");
    sh(worktree, "add", "-A");
    sh(worktree, "commit", "-q", "-m", "feat: first");
    sh(worktree, "push", "-q", "-u", "origin", branch);
    const lease = sh(worktree, "rev-parse", "HEAD");
    sh(worktree, "commit", "-q", "--amend", "-m", "feat: rewritten");
    expect((await pr({ updatePr: false, forceWithLease: "0000000000000000000000000000000000000000" })).ok).toBe(false);
    expect((await pr({ updatePr: false, forceWithLease: lease })).ok).toBe(true);
    expect(sh(origin, "log", "-1", "--format=%s", branch)).toBe("feat: rewritten");
  });

  test("a stacked PR names the PR of its base", async () => {
    const base = `feat/base-${counter}`;
    sh(main, "push", "-q", "origin", `origin/main:refs/heads/${base}`);
    writeFileSync(
      join(root, `gh.view.feat_base-${counter}`),
      JSON.stringify({ number: 5, url: "u5", title: "t", body: "b", baseRefName: "main", state: "OPEN" }),
    );
    writeFileSync(join(worktree, "a.txt"), "a\n");
    writeFileSync(`${helperLog}.input`, "");
    const result = await pr({ base });
    expect(result.ok).toBe(true);
    expect(readFileSync(`${helperLog}.input`, "utf8")).toContain(
      'Start the body with: "Stacked on #5; merge that first."',
    );
    expect(readFileSync(ghLog, "utf8")).toContain(`pr create --base ${base}`);
  });
  test("pi-git's own git commands do not see the switch of the hard stop", async () => {
    process.env.PI_GIT_SWITCH = "/some/switch.json";
    try {
      writeFileSync(join(worktree, "a.txt"), "a\n");
      expect((await pr()).ok).toBe(true);
    } finally {
      delete process.env.PI_GIT_SWITCH;
    }
  });
});

describe("gitCommit", () => {
  test("commits all changes: checks fixed by the helper, message by the helper, nothing pushed", async () => {
    writeFileSync(join(worktree, "bad.txt"), "BAD\n");
    const result = await gitCommit(
      { path: worktree, intent: "Add the thing." },
      { run: runner, config, progress: () => {} },
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(
      /^Committed [0-9a-f]+ "feat: add the thing" on feat\/topic-\d+; the pre-commit checks passed\./,
    );
    expect(result.summary).toContain("The helper fixed on the way:\n- pre-commit: Replaced BAD with GOOD in bad.txt.");
    expect(sh(worktree, "log", "-1", "--format=%s")).toBe("feat: add the thing");
    expect(sh(origin, "branch", "--list", `feat/topic-${counter}`)).toBe("");
  });

  test("nothing to commit, a refused worktree, a failing check", async () => {
    const deps = { run: runner, config, progress: () => {} };
    expect((await gitCommit({ path: worktree, intent: "x" }, deps)).summary).toContain("nothing to commit");
    expect((await gitCommit({ path: main, intent: "x" }, deps)).summary).toContain("is the main checkout");
    writeFileSync(join(worktree, "bad.txt"), "BAD\n");
    const stuck = await gitCommit({ path: worktree, intent: "CANTFIX" }, deps);
    expect(stuck.summary).toContain("The pre-commit checks still fail");
    expect(stuck.summary).toContain("The changes are staged in");
    expect((await gitCommit({ path: worktree, intent: "x", base: "nope" }, deps)).summary).toContain(
      "git fetch origin nope failed",
    );
  });
});

describe("gitPr with locked steps", () => {
  const allow =
    (...steps: Step[]) =>
    (step: Step) =>
      steps.includes(step);
  const run = (allowed: (step: Step) => boolean) =>
    gitPr({ path: worktree, intent: "Add the thing." }, { run: runner, config, progress: () => {}, allowed });

  test("commit locked: nothing happens, an error", async () => {
    writeFileSync(join(worktree, "a.txt"), "a\n");
    const result = await run(allow());
    expect(result.ok).toBe(false);
    expect(result.summary).toContain(
      "Stopped before commit: commit is locked here. Ask the user to run /git unlock commit, or /git commit for one time.",
    );
    expect(sh(worktree, "status", "--porcelain")).toBe("?? a.txt");
  });

  test("push locked: committed, then stopped", async () => {
    writeFileSync(join(worktree, "a.txt"), "a\n");
    const result = await run(allow("commit"));
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(
      /^Committed [0-9a-f]+ "feat: add the thing" on feat\/topic-\d+\. Stopped before push: push is locked here\./,
    );
    expect(sh(origin, "branch", "--list", `feat/topic-${counter}`)).toBe("");
  });

  test("push locked with nothing to commit: an error", async () => {
    writeFileSync(join(worktree, "a.txt"), "a\n");
    sh(worktree, "add", "-A");
    sh(worktree, "commit", "-q", "-m", "feat: by hand");
    expect((await run(allow("commit"))).summary).toContain("git_pr stopped: Stopped before push");
  });

  test("pr locked: committed and pushed, no PR", async () => {
    writeFileSync(join(worktree, "a.txt"), "a\n");
    const result = await run(allow("commit", "push"));
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(
      /^Committed [0-9a-f]+ "feat: add the thing"; pushed feat\/topic-\d+\. Stopped before pr:/,
    );
    expect(sh(origin, "branch", "--list", `feat/topic-${counter}`)).toContain(`feat/topic-${counter}`);
    expect(readFileSync(ghLog, "utf8")).not.toContain("pr create");
  });

  test("pr locked without a new commit", async () => {
    writeFileSync(join(worktree, "a.txt"), "a\n");
    sh(worktree, "add", "-A");
    sh(worktree, "commit", "-q", "-m", "feat: by hand");
    expect((await run(allow("push"))).summary).toMatch(/^Pushed|^pushed/);
  });
});

describe("gitPush", () => {
  const push = (allowed?: (step: Step) => boolean) =>
    gitPush(
      { path: worktree, intent: "Add the thing." },
      { run: runner, config, progress: () => {}, ...(allowed ? { allowed } : {}) },
    );

  test("pushes the commits; uncommitted changes stay", async () => {
    writeFileSync(join(worktree, "a.txt"), "a\n");
    sh(worktree, "add", "-A");
    sh(worktree, "commit", "-q", "-m", "feat: by hand");
    writeFileSync(join(worktree, "later.txt"), "later\n");
    const result = await push();
    expect(result.summary).toBe(
      `Pushed feat/topic-${counter}; the pre-push checks passed. Uncommitted changes stay in the worktree; git_commit commits them.`,
    );
    expect(sh(origin, "log", "-1", "--format=%s", `feat/topic-${counter}`)).toBe("feat: by hand");
  });

  test("a failing pre-push check: the helper fixes it as a commit", async () => {
    writeFileSync(join(worktree, "push.txt"), "FAIL\n");
    sh(worktree, "add", "-A");
    sh(worktree, "commit", "-q", "-m", "feat: by hand");
    const result = await push();
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("The helper fixed on the way:\n- pre-push: Set push.txt to OK.");
    expect(sh(origin, "show", `feat/topic-${counter}:push.txt`)).toBe("OK");
  });

  test("with commit locked, the push runs once and the helper does not fix", async () => {
    writeFileSync(join(worktree, "push.txt"), "FAIL\n");
    sh(worktree, "add", "-A");
    sh(worktree, "commit", "-q", "-m", "feat: by hand");
    const result = await push((step) => step === "push");
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("The push failed:\ncheck: push.txt says FAIL");
    expect(readFileSync(helperLog, "utf8")).toBe("");
  });

  test("nothing to push", async () => {
    expect((await push()).summary).toContain("nothing to do: no changes");
  });
});
