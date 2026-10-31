import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { type Config, defaults } from "./config.ts";
import { type Runner, run } from "./exec.ts";
import { inspectWorktree } from "./git.ts";
import {
  applyPlan,
  gatherWork,
  hasWork,
  isJj,
  isWorkspace,
  jjAtHead,
  jjBranch,
  jjForget,
  jjRootOf,
  jjStart,
  jjSummary,
  parsePlan,
  pushTarget,
  quote,
  rebaseOnRemote,
  wipSnapshot,
} from "./jj.ts";
import { gitCommit, gitPr, gitPush } from "./pr.ts";
import { gitStart, JJ_NOTE } from "./start.ts";
import { type Entry, loadEntries, loadSummaries, saveEntry } from "./state.ts";
import { gitStatus, worktreeOf } from "./status.ts";
import { type PrView, tick } from "./watch.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-git-jj-")));
const origin = join(root, "origin.git");
const main = join(root, "private", "repo");
const other = join(root, "other");
const hooks = join(root, "hooks");
const bin = join(root, "bin");
const ghLog = join(root, "gh.log");
const hookLog = join(root, "hook.log");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, PI_GIT_SWITCH: "" } }).trim();
}

function jj(cwd: string, ...args: string[]): string {
  return execFileSync("jj", ["--no-pager", "--color=never", ...args], { cwd, encoding: "utf8" }).trim();
}

function script(path: string, text: string): void {
  writeFileSync(path, `#!/bin/sh\n${text}`);
  chmodSync(path, 0o755);
}

/** The descriptions of the commits from the base to the parent of the working copy, oldest first. */
function subjects(cwd: string): string[] {
  return jj(cwd, "log", "--no-graph", "--reversed", "-r", "trunk()..@-", "-T", 'description.first_line() ++ "\\n"')
    .split("\n")
    .filter(Boolean);
}

beforeAll(() => {
  for (const key of Object.keys(process.env))
    if (key.startsWith("GIT_") || key.startsWith("JJ_")) delete process.env[key];
  delete process.env.PI_GIT_SWITCH;
  const gitconfig = join(root, "gitconfig");
  writeFileSync(gitconfig, "[user]\n\tname = t\n\temail = t@t\n[init]\n\tdefaultBranch = main\n");
  process.env.GIT_CONFIG_GLOBAL = gitconfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  const jjconfig = join(root, "jj.toml");
  writeFileSync(jjconfig, '[user]\nname = "t"\nemail = "t@t"\n');
  process.env.JJ_CONFIG = jjconfig;

  mkdirSync(hooks);
  mkdirSync(bin);
  // The hooks log what they see: the staged files for pre-commit, the refs for pre-push.
  script(
    join(hooks, "pre-commit"),
    `echo "pre-commit: $(git diff --cached --name-only | tr '\\n' ' ')" >> "${hookLog}"
if git diff --cached | grep -q BAD; then echo "lint: BAD found" >&2; exit 1; fi\n`,
  );
  script(
    join(hooks, "commit-msg"),
    'head -1 "$1" | grep -q "^feat: " || { echo "commit-msg: use feat: <subject>" >&2; exit 1; }\n',
  );
  script(
    join(hooks, "pre-push"),
    `while read local sha remote rest; do echo "pre-push: $remote" >> "${hookLog}"; done
if grep -q FAIL push.txt 2>/dev/null; then echo "check: push.txt says FAIL" >&2; exit 1; fi\n`,
  );
  // The helper: fixes BAD, splits by the files it is given, and writes single messages and PRs.
  script(
    join(bin, "pi"),
    `for last; do :; done
input=$(cat)
case "$PI_GIT_HELPER" in
  fix)
    case "$last" in
      *"CI fails"*) echo ci > ci.txt; echo "Fixed CI." ;;
      *"stopped at conflicts"*)
        case "$input" in
          *LEAVE*) echo "left it" ;;
          *) echo resolved > a.txt; echo "Kept both sides." ;;
        esac ;;
      *"pre-push checks fail"*) echo OK > push.txt; echo "Set push.txt to OK." ;;
      *) sed -i 's/BAD/GOOD/' bad.txt; echo "Replaced BAD with GOOD." ;;
    esac ;;
  answer)
    case "$last" in
      *"logical commits"*)
        case "$input" in
          *SPLITNOPE*) echo '{"commits": [{"files": ["a.txt"], "subject": "feat: only a"}]}' ;;
          *) echo '{"commits": [{"files": ["a.txt"], "subject": "feat: add a", "body": ""}, {"files": ["b.txt", "bad.txt"], "subject": "feat: add b", "body": "B needs a."}]}' ;;
        esac ;;
      *"commit message"*) echo '{"subject": "feat: one change", "body": ""}' ;;
      *"pull request"*) echo '{"title": "feat: jj work", "body": "The body."}' ;;
    esac ;;
esac
`,
  );
  script(
    join(bin, "gh"),
    `echo "$*" >> "${ghLog}"
case "$1 $2" in
  "pr create") echo "https://github.com/owner/repo/pull/9" ;;
  "pr view") cat "${root}/view.json" 2>/dev/null || exit 1 ;;
  "run view") echo "LOG: test failed" ;;
  "api -X") exit 0 ;;
  *) exit 1 ;;
esac
`,
  );

  execFileSync("git", ["init", "-q", "--bare", origin]);
  execFileSync("git", ["clone", "-q", origin, main]);
  writeFileSync(join(main, "README.md"), "# repo\n");
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "feat: start");
  git(main, "push", "-q", "origin", "main");
  git(main, "remote", "set-head", "origin", "main");
  git(main, "config", "core.hooksPath", hooks);
  execFileSync("git", ["clone", "-q", origin, other]);
});

let config: Config;
let counter = 0;
const runner: Runner = (command, args, options) =>
  run(command === "gh" ? join(bin, "gh") : command, args, { ...options, env: { ...options.env } });

beforeEach(() => {
  counter++;
  config = {
    ...defaults(join(root, "pi-git.json"), {}, root),
    pi: join(bin, "pi"),
    attempts: 2,
    worktrees: join(root, "worktrees"),
    stateDir: join(root, `state${counter}`),
    runtimeDir: join(root, `run${counter}`),
    locked: false,
  };
  writeFileSync(ghLog, "");
  writeFileSync(hookLog, "");
  rmSync(join(root, "view.json"), { force: true });
});

/** A new jj workspace through git_start with the jj backend. */
async function start(topic = `topic-${counter}`): Promise<string> {
  const result = await gitStart(
    { repo: main, topic, setup: false },
    { run: runner, config, home: root, progress: () => {}, backendOf: () => "jj" },
  );
  expect(result.summary).toContain(JJ_NOTE);
  expect(result.ok).toBe(true);
  return result.path as string;
}

const deps = () => ({ run: runner, config, progress: () => {} });

describe("git_start with the jj backend", () => {
  test("colocates jj in the main checkout and adds a workspace with the branch as a bookmark", async () => {
    expect(isJj(main)).toBe(false);
    const path = await start("first");
    expect(isJj(main)).toBe(true);
    expect(isWorkspace(path)).toBe(true);
    expect(isWorkspace(main)).toBe(false);
    expect(jjRootOf(join(path, "sub", "file.txt"))).toBe(path);
    expect(await jjBranch(runner, path)).toBe("feat/first");
    expect(git(main, "worktree", "list")).toContain(path);
    // The main checkout keeps its branch: jj in a workspace does not detach it.
    expect(git(main, "symbolic-ref", "--short", "HEAD")).toBe("main");
    const wt = await inspectWorktree(runner, path);
    expect(wt).toMatchObject({ branch: "feat/first", jj: true, mainRoot: main });
  });

  test("the git backend still makes git worktrees in a repository with jj", async () => {
    const result = await gitStart(
      { repo: main, topic: `plain-${counter}`, setup: false },
      { run: runner, config, home: root, progress: () => {} },
    );
    expect(result.ok).toBe(true);
    expect(isWorkspace(result.path as string)).toBe(false);
    expect(git(result.path as string, "symbolic-ref", "--short", "HEAD")).toBe(`feat/plain-${counter}`);
  });

  test("an existing workspace is handed back", async () => {
    const path = await start();
    const again = await gitStart(
      { repo: main, topic: `topic-${counter}`, setup: false },
      { run: runner, config, home: root, progress: () => {}, backendOf: () => "jj" },
    );
    expect(again.summary).toContain(`The worktree already exists: ${path}`);
  });
});

describe("work in progress", () => {
  test("every turn becomes one wip: commit; a turn without changes makes none", async () => {
    const path = await start();
    expect(await wipSnapshot(runner, path, "nothing yet")).toBe(false);
    writeFileSync(join(path, "a.txt"), "a\n");
    expect(await hasWork(runner, path)).toBe(true);
    expect(await wipSnapshot(runner, path, "Add a\nwith details")).toBe(true);
    writeFileSync(join(path, "b.txt"), "b\n");
    jj(path, "describe", "-m", "wip: named by the agent");
    expect(await wipSnapshot(runner, path, "ignored")).toBe(true);
    expect(subjects(path)).toEqual(["wip: Add a", "wip: named by the agent"]);
    expect(await jjSummary(runner, path)).toEqual({
      branch: `feat/topic-${counter}`,
      wip: 2,
      unpushed: 0,
      pushed: false,
    });
  });

  test("described commits on top of work in progress stop git_commit", async () => {
    const path = await start();
    writeFileSync(join(path, "a.txt"), "a\n");
    await wipSnapshot(runner, path, "a");
    writeFileSync(join(path, "b.txt"), "b\n");
    jj(path, "commit", "-m", "feat: b by hand");
    writeFileSync(join(path, "c.txt"), "c\n");
    expect(await gatherWork(runner, path)).toContain("described commits sit on top of the work in progress");
  });
});

describe("git_pr in a jj workspace", () => {
  test("runs the hooks, splits the turns into logical commits, pushes the branch and opens the PR", async () => {
    const path = await start();
    writeFileSync(join(path, "a.txt"), "a\n");
    await wipSnapshot(runner, path, "turn one");
    writeFileSync(join(path, "b.txt"), "b\n");
    writeFileSync(join(path, "bad.txt"), "BAD\n");
    await wipSnapshot(runner, path, "turn two");

    const result = await gitPr({ path, intent: "Add a and b." }, deps());
    expect(result.summary).toContain("Opened PR #9");
    expect(result.ok).toBe(true);
    expect(result.commit?.subject).toBe("2 commits: feat: add a; feat: add b");
    expect(result.notes).toEqual(["pre-commit: Replaced BAD with GOOD."]);

    const branch = `feat/topic-${counter}`;
    expect(git(origin, "log", "--reverse", "--format=%s", `main..${branch}`).split("\n")).toEqual([
      "feat: add a",
      "feat: add b",
    ]);
    expect(git(origin, "show", `${branch}:bad.txt`)).toBe("GOOD");
    expect(git(origin, "log", "-1", "--format=%b", branch)).toBe("B needs a.");
    const hooksSeen = readFileSync(hookLog, "utf8");
    expect(hooksSeen).toContain("pre-commit: a.txt b.txt bad.txt");
    expect(hooksSeen).toContain(`pre-push: refs/heads/${branch}`);
    expect(readFileSync(ghLog, "utf8")).toContain(`pr create --base main --head ${branch} --title feat: jj work`);
    // jj follows the branch on GitHub; nothing is in progress any more.
    expect(await jjSummary(runner, path)).toEqual({ branch, wip: 0, unpushed: 0, pushed: true });
    expect(await worktreeOf(runner, main, branch)).toEqual({ path, main });
    expect(await gitStatus({ run: runner, config, home: root })).toContain(`(${branch}, jj): no PR in the watcher`);
  });

  test("work of several turns: the helper splits it and writes the PR, the agent's title is only a hint", async () => {
    const path = await start();
    writeFileSync(join(path, "a.txt"), "a\n");
    await wipSnapshot(runner, path, "turn one");
    writeFileSync(join(path, "b.txt"), "b\n");
    writeFileSync(join(path, "bad.txt"), "fine\n");
    const result = await gitPr({ path, intent: "Add b.", title: "feat: add b only" }, deps());
    expect(result.ok).toBe(true);
    expect(subjects(path)).toEqual(["feat: add a", "feat: add b"]);
    expect(readFileSync(ghLog, "utf8")).toContain("--title feat: jj work");
  });

  test("work of one turn with the agent's title: one commit and the agent's PR text", async () => {
    const path = await start();
    writeFileSync(join(path, "a.txt"), "a\n");
    writeFileSync(join(path, "b.txt"), "b\n");
    const result = await gitPr({ path, intent: "Add a and b.", title: "feat: add a and b" }, deps());
    expect(result.ok).toBe(true);
    expect(subjects(path)).toEqual(["feat: add a and b"]);
    expect(readFileSync(ghLog, "utf8")).toContain("--title feat: add a and b");
  });

  test("a split that leaves out files becomes one commit", async () => {
    const path = await start();
    writeFileSync(join(path, "a.txt"), "a\n");
    writeFileSync(join(path, "b.txt"), "SPLITNOPE\n");
    const result = await gitCommit({ path, intent: "Both." }, deps());
    expect(result.ok).toBe(true);
    expect(subjects(path)).toEqual(["feat: one change"]);
  });

  test("after the watcher pushed, the next push rebases on GitHub with jj", async () => {
    const path = await start();
    const branch = `feat/topic-${counter}`;
    writeFileSync(join(path, "a.txt"), "a\n");
    expect((await gitPr({ path, intent: "One file.", title: "feat: add a" }, deps())).ok).toBe(true);
    // Someone else (the watcher) adds a commit to the branch on GitHub.
    git(other, "fetch", "-q", "origin");
    git(other, "checkout", "-q", "-B", branch, `origin/${branch}`);
    writeFileSync(join(other, "fix.txt"), "fix\n");
    git(other, "add", "-A");
    git(other, "commit", "-q", "--no-verify", "-m", "feat: fix by the watcher");
    git(other, "push", "-q", "--no-verify", "origin", branch);

    writeFileSync(join(path, "c.txt"), "c\n");
    await wipSnapshot(runner, path, "more");
    expect((await gitCommit({ path, intent: "More.", title: "feat: add c" }, deps())).ok).toBe(true);
    const pushed = await gitPush({ path, intent: "More." }, deps());
    expect(pushed.summary).toContain("Pushed");
    expect(git(origin, "log", "--reverse", "--format=%s", `main..${branch}`).split("\n")).toEqual([
      "feat: add a",
      "feat: fix by the watcher",
      "feat: add c",
    ]);
  });

  test("the watcher's view: at the head of the PR, then forget the workspace after the merge", async () => {
    const path = await start();
    const branch = `feat/topic-${counter}`;
    writeFileSync(join(path, "a.txt"), "a\n");
    expect((await gitPr({ path, intent: "A.", title: "feat: add a" }, deps())).ok).toBe(true);
    const head = git(origin, "rev-parse", branch);
    expect(await jjAtHead(runner, path, branch, head)).toBeUndefined();
    writeFileSync(join(path, "x.txt"), "x\n");
    expect(await jjAtHead(runner, path, branch, head)).toContain("work in progress");
    execFileSync("rm", ["x.txt"], { cwd: path });

    git(main, "worktree", "remove", "--force", path);
    await jjForget(runner, main, path, branch);
    expect(existsSync(path)).toBe(false);
    expect(jj(main, "workspace", "list", "-T", 'name ++ "\\n"')).not.toContain(`topic-${counter}`);
    expect(git(main, "branch", "--list", branch)).toBe("");
  });
});

describe("parsePlan", () => {
  const files = ["a.txt", "b.txt"];
  test("a valid split", () => {
    expect(
      parsePlan(
        {
          commits: [
            { files: ["a.txt"], subject: " feat: a " },
            { files: ["b.txt"], subject: "feat: b", body: "Why." },
          ],
        },
        files,
      ),
    ).toEqual([
      { files: ["a.txt"], message: "feat: a\n" },
      { files: ["b.txt"], message: "feat: b\n\nWhy.\n" },
    ]);
  });
  test("what is wrong with an answer", () => {
    expect(parsePlan({}, files)).toEqual(new Error('the answer has no "commits" list'));
    expect(parsePlan({ commits: [{ files: [] }] }, files)).toEqual(new Error('commit 1 needs "files" and a "subject"'));
    expect(parsePlan({ commits: [{ files: ["c.txt"], subject: "s" }] }, files)).toEqual(
      new Error("commit 1 names c.txt, which is not changed"),
    );
    expect(
      parsePlan(
        {
          commits: [
            { files: ["a.txt"], subject: "s" },
            { files: ["a.txt", "b.txt"], subject: "t" },
          ],
        },
        files,
      ),
    ).toEqual(new Error("a.txt is in commits 1 and 2"));
    expect(parsePlan({ commits: [{ files: ["a.txt"], subject: "s" }] }, files)).toEqual(
      new Error("no commit has b.txt"),
    );
  });
  test("quote makes revset strings", () => {
    expect(quote('d i/z "q".txt')).toBe('"d i/z \\"q\\".txt"');
  });
});

/** Another clone adds a commit to the branch on GitHub, as the watcher or a colleague does. */
function pushFromElsewhere(branch: string, file: string, text: string): string {
  git(other, "fetch", "-q", "origin");
  git(other, "checkout", "-q", "-B", branch, `origin/${branch}`);
  writeFileSync(join(other, file), text);
  git(other, "add", "-A");
  git(other, "commit", "-q", "--no-verify", "-m", `feat: ${file} from elsewhere`);
  git(other, "push", "-q", "--no-verify", "origin", branch);
  return git(other, "rev-parse", "HEAD");
}

describe("failures in a jj workspace", () => {
  test("a pre-push fix of the helper goes into the commit that is not pushed yet", async () => {
    const path = await start();
    writeFileSync(join(path, "a.txt"), "a\n");
    writeFileSync(join(path, "push.txt"), "FAIL\n");
    const result = await gitPr({ path, intent: "A.", title: "feat: add a" }, deps());
    expect(result.ok).toBe(true);
    expect(result.notes).toEqual(["pre-push: Set push.txt to OK."]);
    const branch = `feat/topic-${counter}`;
    expect(git(origin, "log", "--format=%s", `main..${branch}`)).toBe("feat: add a");
    expect(git(origin, "show", `${branch}:push.txt`)).toBe("OK");
  });

  test("commits on GitHub that conflict: everything is put back", async () => {
    const path = await start();
    const branch = `feat/topic-${counter}`;
    writeFileSync(join(path, "a.txt"), "a\n");
    expect((await gitPr({ path, intent: "A.", title: "feat: add a" }, deps())).ok).toBe(true);
    pushFromElsewhere(branch, "a.txt", "theirs\n");
    writeFileSync(join(path, "a.txt"), "mine\n");
    expect((await gitCommit({ path, intent: "Mine.", title: "feat: change a" }, deps())).ok).toBe(true);
    const before = subjects(path);
    const pushed = await gitPush({ path, intent: "Mine." }, deps());
    expect(pushed.ok).toBe(false);
    expect(pushed.summary).toContain("conflict with this workspace");
    expect(subjects(path)).toEqual(before);
  });

  test("at the head of the PR: behind is moved up, commits that are not on GitHub stop it", async () => {
    const path = await start();
    const branch = `feat/topic-${counter}`;
    writeFileSync(join(path, "a.txt"), "a\n");
    expect((await gitPr({ path, intent: "A.", title: "feat: add a" }, deps())).ok).toBe(true);
    const head = pushFromElsewhere(branch, "b.txt", "b\n");
    expect(await jjAtHead(runner, path, branch, head)).toBeUndefined();
    expect(jj(path, "log", "--no-graph", "-r", "@-", "-T", "commit_id")).toBe(head);
    writeFileSync(join(path, "c.txt"), "c\n");
    expect((await gitCommit({ path, intent: "C.", title: "feat: add c" }, deps())).ok).toBe(true);
    expect(await jjAtHead(runner, path, branch, head)).toContain("commits that are not on GitHub");
  });

  test("the branch of a workspace with another name: the newest bookmark ahead of trunk", async () => {
    const path = join(root, "worktrees", "origin", `odd-${counter}`);
    jj(main, "workspace", "add", "--colocate", "--name", `odd-${counter}`, "-r", "main@origin", path);
    writeFileSync(join(path, "a.txt"), "a\n");
    jj(path, "commit", "-m", "feat: a");
    jj(path, "bookmark", "create", `fix/other-${counter}`, "-r", "@-");
    expect(await jjBranch(runner, path)).toBe(`fix/other-${counter}`);
  });
});

describe("the watcher with a jj workspace", () => {
  const red = {
    __typename: "CheckRun",
    name: "test",
    status: "COMPLETED",
    conclusion: "FAILURE",
    detailsUrl: "https://github.com/o/r/actions/runs/42/job/7",
  };

  /** A PR from a jj workspace, in the watcher's queue. */
  async function opened(intent = "Add a."): Promise<{ path: string; branch: string }> {
    const path = await start();
    const branch = `feat/topic-${counter}`;
    writeFileSync(join(path, "a.txt"), "a\n");
    expect((await gitPr({ path, intent: "A.", title: "feat: add a" }, deps())).ok).toBe(true);
    queue(path, branch, "main", intent);
    return { path, branch };
  }

  function queue(path: string, branch: string, base: string, intent: string, baseSha?: string): void {
    const entry: Entry = {
      id: `o__r__${counter}`,
      repo: "o/r",
      number: counter,
      url: `https://github.com/o/r/pull/${counter}`,
      worktree: path,
      mainRoot: main,
      branch,
      base,
      ...(baseSha ? { baseSha } : {}),
      intent,
      sessionId: "s1",
      status: "watching",
      attempts: 0,
      errors: 0,
      notes: [],
      updated: "",
    };
    saveEntry(config.stateDir, entry);
  }

  /** The default branch on GitHub gets its own a.txt: the PR conflicts with it. */
  function conflictOnMain(): void {
    git(other, "fetch", "-q", "origin");
    git(other, "checkout", "-q", "-B", "main", "origin/main");
    writeFileSync(join(other, "a.txt"), `theirs ${counter}\n`);
    git(other, "add", "-A");
    git(other, "commit", "-q", "--no-verify", "-m", "feat: their a");
    git(other, "push", "-q", "--no-verify", "origin", "main");
  }

  function view(branch: string, fields: Partial<PrView>): void {
    const pr = {
      state: "OPEN",
      mergeable: "MERGEABLE",
      headRefOid: git(origin, "rev-parse", branch),
      statusCheckRollup: [],
    };
    writeFileSync(join(root, "view.json"), JSON.stringify({ ...pr, ...fields }));
  }

  const once = () => tick({ run: runner, config, gitPr });
  const texts = () => loadSummaries(config.stateDir).map((summary) => summary.text);

  test("red CI: the helper's fix becomes a commit, pushed through jj", async () => {
    const { path, branch } = await opened();
    view(branch, { statusCheckRollup: [red] });
    await once();
    expect(git(origin, "log", "--reverse", "--format=%s", `main..${branch}`).split("\n")).toEqual([
      "feat: add a",
      "feat: one change",
    ]);
    expect(git(origin, "show", `${branch}:ci.txt`)).toBe("ci");
    expect(await jjSummary(runner, path)).toEqual({ branch, wip: 0, unpushed: 0, pushed: true });
    expect(loadEntries(config.stateDir)[0]?.notes[0]).toContain("Fixed CI.");
  });

  test("a conflict: jj rebases, the helper resolves it, and the branch is pushed with a lease", async () => {
    const { path, branch } = await opened();
    conflictOnMain();
    view(branch, { mergeable: "CONFLICTING" });
    await once();
    expect(git(origin, "log", "--format=%s", `main..${branch}`)).toBe("feat: add a");
    expect(git(origin, "merge-base", "--is-ancestor", "main", branch)).toBe("");
    expect(git(origin, "show", `${branch}:a.txt`)).toBe("resolved");
    expect(loadEntries(config.stateDir)[0]?.notes.join("\n")).toContain(
      "conflict with main in a.txt: Kept both sides.",
    );
    expect(jj(path, "log", "--no-graph", "-r", "conflicts()", "-T", "commit_id")).toBe("");
    expect(jj(path, "log", "--no-graph", "-r", "@-", "-T", "commit_id")).toBe(git(origin, "rev-parse", branch));
  });

  test("a conflict the helper cannot resolve: everything is put back", async () => {
    const { path, branch } = await opened("LEAVE it");
    const head = git(origin, "rev-parse", branch);
    conflictOnMain();
    view(branch, { mergeable: "CONFLICTING" });
    await once();
    expect(texts()[0]).toContain("the helper could not resolve the conflict with main: left it");
    expect(git(origin, "rev-parse", branch)).toBe(head);
    expect(jj(path, "log", "--no-graph", "-r", "@-", "-T", "commit_id")).toBe(head);
    expect(jj(path, "log", "--no-graph", "-r", "conflicts()", "-T", "commit_id")).toBe("");
  });

  test("a stacked PR whose base was squash-merged: only its own commits move to the new base", async () => {
    const basePath = await start(`base-${counter}`);
    const baseBranch = `feat/base-${counter}`;
    writeFileSync(join(basePath, "base.txt"), "base\n");
    expect((await gitPr({ path: basePath, intent: "Base.", title: "feat: base" }, deps())).ok).toBe(true);
    const baseSha = git(origin, "rev-parse", baseBranch);
    const stacked = await gitStart(
      { repo: main, topic: `top-${counter}`, base: baseBranch, setup: false },
      { run: runner, config, home: root, progress: () => {}, backendOf: () => "jj" },
    );
    const path = stacked.path as string;
    const branch = `feat/top-${counter}`;
    writeFileSync(join(path, "top.txt"), "top\n");
    expect((await gitPr({ path, intent: "Top.", title: "feat: top", base: baseBranch }, deps())).ok).toBe(true);
    // GitHub squash-merges the base and deletes its branch.
    git(other, "fetch", "-q", "origin");
    git(other, "checkout", "-q", "-B", "main", "origin/main");
    git(other, "merge", "-q", "--squash", `origin/${baseBranch}`);
    git(other, "commit", "-q", "--no-verify", "-m", "feat: base (#1)");
    git(other, "push", "-q", "--no-verify", "origin", "main", `:${baseBranch}`);
    queue(path, branch, baseBranch, "Top.", baseSha);
    view(branch, { baseRefName: "main" });
    await once();
    expect(git(origin, "log", "--format=%s", `main..${branch}`)).toBe("feat: top");
    expect(loadEntries(config.stateDir)[0]?.notes.join("\n")).toContain(`the base ${baseBranch} was merged; rebased`);
  });

  test("merged: removes the workspace, forgets it in jj and deletes the bookmark", async () => {
    const { path, branch } = await opened();
    view(branch, { state: "MERGED" });
    await once();
    expect(existsSync(path)).toBe(false);
    expect(jj(main, "workspace", "list", "-T", 'name ++ "\\n"')).not.toContain(`topic-${counter}`);
    expect(git(main, "branch", "--list", branch)).toBe("");
    expect(texts()[0]).toContain(`is merged; removed the worktree ${path} and the branch ${branch}`);
  });

  test("merged with work in progress: the workspace is kept", async () => {
    const { path, branch } = await opened();
    writeFileSync(join(path, "later.txt"), "later\n");
    await wipSnapshot(runner, path, "later");
    view(branch, { state: "MERGED" });
    await once();
    expect(existsSync(path)).toBe(true);
    expect(texts()[0]).toContain("has uncommitted changes, so it is kept");
  });
});

describe("when jj fails", () => {
  /** A runner where jj answers by the first words of its command, and everything else fails. */
  const scripted =
    (answers: Record<string, { code: number; stdout?: string }>): Runner =>
    async (command, args) => {
      const words = args.filter((arg) => !arg.startsWith("--no-pager") && !arg.startsWith("--color")).join(" ");
      const key = Object.keys(answers).find((prefix) => words.startsWith(prefix));
      const answer = key === undefined ? { code: 1 } : (answers[key] as { code: number; stdout?: string });
      return { code: command === "jj" ? answer.code : 1, stdout: answer.stdout ?? "", stderr: "jj: no" };
    };

  test("every step says what failed", async () => {
    const failing = scripted({});
    expect(await wipSnapshot(failing, "/w", "x")).toBe(false);
    expect(await gatherWork(scripted({ log: { code: 0, stdout: "x\n" } }), "/w")).toContain(
      "described commits sit on top",
    );
    expect(
      await gatherWork(scripted({ "log --no-graph -r (roots(": { code: 0 }, log: { code: 0, stdout: "x\n" } }), "/w"),
    ).toContain("jj squash failed");
    expect(await gatherWork(scripted({ log: { code: 0 } }), "/w")).toContain("jj describe failed");
    expect(await applyPlan(failing, "/w", [])).toBe("no commits planned");
    expect(
      await applyPlan(failing, "/w", [
        { files: ["a"], message: "a" },
        { files: ["b"], message: "b" },
      ]),
    ).toContain("jj split failed");
    expect(await applyPlan(failing, "/w", [{ files: ["a"], message: "a" }])).toContain("jj describe failed");
    expect(await applyPlan(scripted({ describe: { code: 0 } }), "/w", [{ files: ["a"], message: "a" }])).toContain(
      "jj new failed",
    );
    expect(await pushTarget(scripted({ log: { code: 0, stdout: "a\nb\n" } }), "/w")).toEqual(
      new Error("the logical commits have 2 heads; put them in one line first"),
    );
    expect(await rebaseOnRemote(failing, "/w", "b")).toContain("jj git fetch failed");
    expect(
      await rebaseOnRemote(scripted({ "git fetch": { code: 0 }, op: { code: 0, stdout: "op1" } }), "/w", "b"),
    ).toContain("jj rebase failed");
    const dir = mkdtempSync(join(tmpdir(), "pi-git-jjfail-"));
    expect(
      await jjStart(failing, {
        main: dir,
        path: join(dir, "a", "w"),
        topic: "w",
        branch: "feat/w",
        from: "origin/main",
      }),
    ).toContain("jj workspace add failed");
    expect(
      await jjStart(scripted({ workspace: { code: 0 } }), {
        main: dir,
        path: join(dir, "w"),
        topic: "w",
        branch: "feat/w",
        from: "dev",
      }),
    ).toContain("jj bookmark create failed");
    expect(await jjAtHead(scripted({ log: { code: 0 }, "git fetch": { code: 0 } }), "/w", "b", "h")).toContain(
      "could not move the workspace",
    );
    await jjForget(failing, "/m", "/w/x", "b");
    expect(await jjSummary(failing, "/w")).toEqual({ branch: "no branch", wip: 0, unpushed: 0, pushed: false });
  });

  test("git_start reports a jj that cannot colocate", async () => {
    const plainMain = join(root, "private", "plain");
    execFileSync("git", ["clone", "-q", origin, plainMain]);
    const failing: Runner = (command, args, options) =>
      command === "jj" ? Promise.resolve({ code: 1, stdout: "", stderr: "no jj" }) : runner(command, args, options);
    const result = await gitStart(
      { repo: plainMain, topic: "nojj", setup: false },
      { run: failing, config, home: root, progress: () => {}, backendOf: () => "jj" },
    );
    expect(result).toMatchObject({ ok: false });
    expect(result.summary).toContain("jj git init --colocate failed");
  });
});
