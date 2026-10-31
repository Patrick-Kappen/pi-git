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
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { listAttention } from "./attention.ts";
import { type Config, defaults } from "./config.ts";
import { type Runner, run } from "./exec.ts";
import type { gitPr as GitPr } from "./pr.ts";
import { type Entry, loadEntries, loadSummaries, lock, saveEntry } from "./state.ts";
import { type Check, checkState, type PrView, rollup, tick } from "./watch.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-git-watch-")));
const origin = join(root, "origin.git");
const main = join(root, "main");
const bin = join(root, "bin");
const ghLog = join(root, "gh.log");

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function script(path: string, text: string): void {
  writeFileSync(path, `#!/bin/sh\n${text}`);
  chmodSync(path, 0o755);
}

beforeAll(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];
  const gitconfig = join(root, "gitconfig");
  writeFileSync(gitconfig, "[user]\n\tname = t\n\temail = t@t\n[init]\n\tdefaultBranch = main\n");
  process.env.GIT_CONFIG_GLOBAL = gitconfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  mkdirSync(bin);
  script(
    join(bin, "gh"),
    `echo "$*" >> "${ghLog}"
case "$1 $2" in
  "pr view") cat "${root}/view.json" 2>/dev/null || exit 1 ;;
  "run view") echo "LOG: test failed in a.ts" ;;
  "run rerun") exit 0 ;;
  "api -X") if [ -f "${root}/gh.apifail" ]; then echo "no permission" >&2; exit 1; fi ;;
  *) exit 1 ;;
esac
`,
  );
  script(
    join(bin, "pi"),
    `input=$(cat)
case "$input" in
  *CANTFIX*) echo "CANNOT FIX: out of scope" ;;
  *"Files with conflicts"*) case "$input" in *LEAVE*) echo "left it" ;; *) echo resolved > a.txt; echo "Kept both sides." ;; esac ;;
  *NOCHANGE*) echo "Not caused by the PR." ;;
  *) echo fixed >> fix.txt; echo "Fixed the test." ;;
esac
`,
  );
  execFileSync("git", ["init", "-q", "--bare", origin]);
  execFileSync("git", ["clone", "-q", origin, main]);
  writeFileSync(join(main, "a.txt"), "start\n");
  sh(main, "add", "-A");
  sh(main, "commit", "-q", "-m", "start");
  sh(main, "push", "-q", "origin", "main");
});

let config: Config;
let n = 0;
let entry: Entry;
const gitPr = vi.fn<typeof GitPr>();
const logs: string[] = [];
const runner: Runner = (command, args, options) => run(command === "gh" ? join(bin, "gh") : command, args, options);

function view(fields: Partial<PrView>): void {
  writeFileSync(
    join(root, "view.json"),
    JSON.stringify({ state: "OPEN", mergeable: "MERGEABLE", headRefOid: head(), statusCheckRollup: [], ...fields }),
  );
}

function head(): string {
  return sh(entry.worktree, "rev-parse", "HEAD");
}

const red: Check = {
  __typename: "CheckRun",
  name: "test",
  status: "COMPLETED",
  conclusion: "FAILURE",
  detailsUrl: "https://github.com/o/r/actions/runs/42/job/7",
};

beforeEach(() => {
  n++;
  const worktree = join(root, "worktrees", `t${n}`);
  sh(main, "fetch", "-q", "origin");
  sh(main, "worktree", "add", "-q", "-b", `feat/t${n}`, worktree, "origin/main");
  writeFileSync(join(worktree, "a.txt"), `mine ${n}\n`);
  sh(worktree, "commit", "-q", "-am", "mine");
  sh(worktree, "push", "-q", "-u", "origin", `feat/t${n}`);
  config = {
    ...defaults("p", {}, root),
    stateDir: join(root, `state${n}`),
    pi: join(bin, "pi"),
    attempts: 2,
    locked: false,
  };
  entry = {
    id: `o__r__${n}`,
    repo: "o/r",
    number: n,
    url: `https://github.com/o/r/pull/${n}`,
    worktree,
    mainRoot: main,
    branch: `feat/t${n}`,
    base: "main",
    intent: "Change a.",
    sessionId: "s1",
    status: "watching",
    attempts: 0,
    errors: 0,
    notes: [],
    updated: "",
  };
  saveEntry(config.stateDir, entry);
  writeFileSync(ghLog, "");
  rmSync(join(root, "view.json"), { force: true });
  gitPr.mockReset();
  gitPr.mockResolvedValue({ ok: true, summary: "Pushed.", notes: [] });
  logs.length = 0;
});

const once = () =>
  tick({ run: runner, config, gitPr, now: () => new Date("2026-10-31T00:00:00Z"), log: (text) => logs.push(text) });
const saved = () => loadEntries(config.stateDir)[0];
const texts = () => loadSummaries(config.stateDir).map((summary) => summary.text);

describe("checkState and rollup", () => {
  test.each<[Check, string]>([
    [{ __typename: "CheckRun", status: "IN_PROGRESS" }, "pending"],
    [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }, "passed"],
    [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED" }, "passed"],
    [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "ACTION_REQUIRED" }, "pending"],
    [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }, "failed"],
    [{ __typename: "StatusContext", state: "SUCCESS" }, "passed"],
    [{ __typename: "StatusContext", state: "PENDING" }, "pending"],
    [{ state: "FAILURE" }, "failed"],
    [{ __typename: "StatusContext" }, "failed"],
    [{}, "pending"],
  ])("%j is %s", (check, state) => {
    expect(checkState(check)).toBe(state);
  });

  test("rollup", () => {
    expect(rollup([])).toBe("passed");
    expect(rollup([{ state: "SUCCESS" }, { status: "QUEUED" }])).toBe("pending");
    expect(rollup([{ state: "SUCCESS" }, { status: "QUEUED" }, { state: "ERROR" }])).toBe("failed");
  });
});

describe("tick", () => {
  test("pending checks: keep watching, no summary", async () => {
    view({ statusCheckRollup: [{ status: "IN_PROGRESS", name: "ci" }] });
    expect(await once()).toBe(1);
    expect(texts()).toEqual([]);
    expect(saved()?.updated).toBe("2026-10-31T00:00:00.000Z");
  });

  test("green: reported once per head", async () => {
    view({ statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }] });
    await once();
    await once();
    expect(texts()).toEqual([`pi-git: PR #${n} (o/r) is green and ready to merge: https://github.com/o/r/pull/${n}`]);
    expect(saved()).toMatchObject({ status: "green", greenSha: head() });
  });

  test("merged: removes the worktree and the branch, and stops watching", async () => {
    view({ state: "MERGED" });
    await once();
    expect(existsSync(entry.worktree)).toBe(false);
    expect(sh(main, "branch", "--list", entry.branch)).toBe("");
    expect(texts()[0]).toBe(
      `pi-git: PR #${n} (o/r) is merged; removed the worktree ${entry.worktree} and the branch ${entry.branch}, also on GitHub.`,
    );
    expect(readFileSync(ghLog, "utf8")).toContain(`api -X DELETE repos/o/r/git/refs/heads/${entry.branch}`);
    expect(saved()).toBeUndefined();
  });

  test("merged, then a commit on the branch: the worktree and the branch are kept", async () => {
    view({ state: "MERGED" });
    writeFileSync(join(entry.worktree, "later.txt"), "later\n");
    sh(entry.worktree, "add", "-A");
    sh(entry.worktree, "commit", "-q", "-m", "later");
    sh(entry.worktree, "push", "-q", "origin", entry.branch);
    await once();
    expect(existsSync(entry.worktree)).toBe(true);
    expect(sh(main, "branch", "--list", entry.branch)).toContain(entry.branch);
    expect(texts()[0]).toMatch(
      /is merged, but the branch feat\/t\d+ has commits that are not in the PR: 1 on the worktree \(\w{8}\), 1 on GitHub \(\w{8}\)\. The worktree .* and the branch are kept/,
    );
    expect(readFileSync(ghLog, "utf8")).not.toContain("api -X DELETE");
    expect(
      listAttention(config.stateDir)
        .map((item) => item.text)
        .join("\n"),
    ).toContain("not in the PR");
  });

  test("merged, and a commit only on GitHub: kept", async () => {
    view({ state: "MERGED" });
    writeFileSync(join(entry.worktree, "later.txt"), "later\n");
    sh(entry.worktree, "add", "-A");
    sh(entry.worktree, "commit", "-q", "-m", "later");
    sh(entry.worktree, "push", "-q", "origin", entry.branch);
    sh(entry.worktree, "reset", "-q", "--hard", "HEAD~1");
    await once();
    expect(existsSync(entry.worktree)).toBe(true);
    expect(texts()[0]).toContain("commits that are not in the PR: 1 on GitHub");
  });

  test("merged, the PR's head cannot be fetched: kept", async () => {
    view({ state: "MERGED", headRefOid: "0123456789abcdef0123456789abcdef01234567" });
    await once();
    expect(existsSync(entry.worktree)).toBe(true);
    expect(texts()[0]).toContain("the PR's head 01234567 could not be fetched to compare");
  });

  test("merged with uncommitted changes: the worktree is kept", async () => {
    writeFileSync(join(entry.worktree, "wip.txt"), "wip\n");
    view({ state: "MERGED" });
    await once();
    expect(existsSync(entry.worktree)).toBe(true);
    expect(texts()[0]).toContain("has uncommitted changes, so it is kept");
  });

  test("merged, worktree already gone; merged, cleanup fails", async () => {
    view({ state: "MERGED" });
    saveEntry(config.stateDir, { ...entry, worktree: join(root, "gone") });
    await once();
    expect(texts()[0]).toContain("is merged. The worktree was already gone.");
    saveEntry(config.stateDir, { ...entry, branch: "no-such-branch", id: "other" });
    await once();
    expect(texts().join("\n")).toContain("is merged, but the cleanup failed");
  });

  test("closed, and a missing worktree", async () => {
    view({ state: "CLOSED" });
    await once();
    expect(texts()[0]).toContain("was closed without merging");
    view({});
    saveEntry(config.stateDir, { ...entry, worktree: join(root, "gone") });
    await once();
    expect(texts().join("\n")).toContain("has no worktree any more");
  });

  test("red CI: the helper fixes, pi-git pushes, once per head", async () => {
    view({ statusCheckRollup: [red] });
    await once();
    expect(readFileSync(join(entry.worktree, "fix.txt"), "utf8")).toBe("fixed\n");
    expect(gitPr).toHaveBeenCalledTimes(1);
    expect(gitPr.mock.calls[0]?.[0]).toEqual({
      path: entry.worktree,
      intent: "Change a.\n\nThis commit fixes the failing CI checks: test.",
      base: "main",
      updatePr: false,
    });
    expect(readFileSync(ghLog, "utf8")).toContain("run view 42 -R o/r --log-failed");
    expect(saved()).toMatchObject({ attempts: 1, fixedSha: head(), notes: ["CI (test): Fixed the test."] });
    expect(logs).toContain(`o__r__${n}: fixing ci (attempt 1)`);
    await once();
    expect(gitPr).toHaveBeenCalledTimes(1);
  });

  test("red CI that the PR did not cause: the failed jobs run again", async () => {
    saveEntry(config.stateDir, { ...entry, intent: "NOCHANGE" });
    view({
      statusCheckRollup: [
        red,
        {
          __typename: "StatusContext",
          context: "bot",
          state: "ERROR",
          targetUrl: "https://bot/1",
          description: "boom",
        },
      ],
    });
    await once();
    expect(gitPr).not.toHaveBeenCalled();
    expect(readFileSync(ghLog, "utf8")).toContain("run rerun 42 -R o/r --failed");
  });

  test("red CI: the helper cannot fix, or pushing fails", async () => {
    saveEntry(config.stateDir, { ...entry, intent: "CANTFIX" });
    view({ statusCheckRollup: [red] });
    await once();
    expect(texts()[0]).toContain("needs you: the helper cannot fix CI (test): CANNOT FIX: out of scope");
    expect(saved()).toBeUndefined();
  });

  test("red CI: the push of the fix fails", async () => {
    gitPr.mockResolvedValue({ ok: false, summary: "git_pr stopped: no", notes: [] });
    view({ statusCheckRollup: [red] });
    await once();
    expect(texts()[0]).toContain("needs you: git_pr stopped: no");
  });

  test("red CI: no attempts left", async () => {
    saveEntry(config.stateDir, { ...entry, attempts: 2, notes: ["earlier fix"] });
    view({ statusCheckRollup: [red] });
    await once();
    expect(texts()[0]).toBe(
      `pi-git: PR #${n} (o/r) needs you: CI still fails after 2 fixes by the helper. ${entry.url}\nThe helper:\n- earlier fix`,
    );
  });

  test("red CI with uncommitted changes, or commits not on GitHub", async () => {
    writeFileSync(join(entry.worktree, "wip.txt"), "wip\n");
    view({ statusCheckRollup: [red] });
    await once();
    expect(texts()[0]).toContain("has uncommitted changes");
    rmSync(join(entry.worktree, "wip.txt"));
    saveEntry(config.stateDir, entry);
    const remoteHead = head();
    writeFileSync(join(entry.worktree, "b.txt"), "b\n");
    sh(entry.worktree, "add", "-A");
    sh(entry.worktree, "commit", "-q", "-m", "local only");
    view({ statusCheckRollup: [red], headRefOid: remoteHead });
    await once();
    expect(texts().join("\n")).toContain("has commits that are not on GitHub");
  });

  test("the worktree is behind GitHub: it is fast-forwarded first", async () => {
    const other = join(root, `other${n}`);
    execFileSync("git", ["clone", "-q", "-b", entry.branch, origin, other]);
    writeFileSync(join(other, "c.txt"), "c\n");
    sh(other, "add", "-A");
    sh(other, "commit", "-q", "-m", "remote");
    sh(other, "push", "-q");
    view({ statusCheckRollup: [red], headRefOid: sh(other, "rev-parse", "HEAD") });
    await once();
    expect(head()).toBe(sh(other, "rev-parse", "HEAD"));
    expect(gitPr).toHaveBeenCalledTimes(1);
  });

  test("a conflict: rebase, the helper resolves, push with a lease", async () => {
    writeFileSync(join(main, "a.txt"), `base ${n}\n`);
    sh(main, "commit", "-q", "-am", "base moved");
    sh(main, "push", "-q", "origin", "HEAD:main");
    const before = head();
    view({ mergeable: "CONFLICTING" });
    await once();
    expect(readFileSync(join(entry.worktree, "a.txt"), "utf8")).toBe("resolved\n");
    expect(sh(entry.worktree, "log", "--format=%s", "-3").split("\n")).toEqual([
      "mine",
      "base moved",
      expect.any(String),
    ]);
    expect(gitPr.mock.calls[0]?.[0]).toMatchObject({ forceWithLease: before, updatePr: false });
    expect(saved()?.notes[0]).toMatch(/^conflict with main in a.txt: Kept both sides\./);
  });

  test("a conflict the helper leaves: the rebase is aborted", async () => {
    writeFileSync(join(main, "a.txt"), `base again ${n}\n`);
    sh(main, "commit", "-q", "-am", "base moved again");
    sh(main, "push", "-q", "origin", "HEAD:main");
    saveEntry(config.stateDir, { ...entry, intent: "LEAVE" });
    view({ mergeable: "CONFLICTING" });
    await once();
    expect(texts()[0]).toContain("the helper could not resolve the conflict with main: left it");
    expect(sh(entry.worktree, "status", "--porcelain")).toBe("");
    expect(existsSync(join(entry.worktree, ".git"))).toBe(true);
  });

  test("gh fails: counted, and given up after 30 times in a row", async () => {
    await once();
    expect(saved()?.errors).toBe(1);
    saveEntry(config.stateDir, { ...entry, errors: 29 });
    await once();
    expect(texts()[0]).toContain("could not be read with gh 30 times in a row");
    writeFileSync(join(root, "view.json"), "{");
    saveEntry(config.stateDir, entry);
    await once();
    expect(saved()?.errors).toBe(1);
  });

  test("another watcher holds the lock", async () => {
    const release = lock(config.runtimeDir, "watcher", 60_000);
    expect(await once()).toBe(0);
    expect(logs).toEqual(["another watcher is running"]);
    release?.();
  });

  test("an error in one PR does not stop the others", async () => {
    gitPr.mockRejectedValue(new Error("boom"));
    view({ statusCheckRollup: [red] });
    expect(await once()).toBe(1);
    expect(logs).toContain(`o__r__${n}: boom`);
  });

  test("locked: fixes wait for an unlock, reported once; after a merge the worktree stays", async () => {
    config = { ...config, locked: true };
    view({ statusCheckRollup: [red] });
    await once();
    await once();
    expect(gitPr).not.toHaveBeenCalled();
    expect(texts()).toEqual([
      `pi-git: PR #${n} (o/r): CI fails, but git changes are locked in o/r. Unlock commit and push (/git unlock commit push) to let the helper fix it. ${entry.url}`,
    ]);
    view({ mergeable: "CONFLICTING" });
    saveEntry(config.stateDir, entry);
    await once();
    expect(texts().join("\n")).toContain("it conflicts with the base, but git changes are locked");
    view({ state: "MERGED" });
    await once();
    expect(existsSync(entry.worktree)).toBe(true);
    expect(texts().join("\n")).toContain("are kept: worktree is locked in o/r.");
  });

  test("after an interrupted conflict fix: the watcher aborts its rebase, then fixes again", async () => {
    writeFileSync(join(main, "a.txt"), `base reboot ${n}\n`);
    sh(main, "commit", "-q", "-am", "base moved for reboot");
    sh(main, "push", "-q", "origin", "HEAD:main");
    const before = head();
    sh(entry.worktree, "fetch", "-q", "origin");
    // A rebase that stopped at a conflict, as if the machine went down during the fix.
    try {
      execFileSync("git", ["rebase", "origin/main"], {
        cwd: entry.worktree,
        stdio: "ignore",
        env: { ...process.env, GIT_EDITOR: "true" },
      });
    } catch {
      // The conflict is the point.
    }
    saveEntry(config.stateDir, { ...entry, working: "conflict", attempts: 1 });
    view({ mergeable: "CONFLICTING", headRefOid: before });
    await once();
    expect(saved()?.notes[0]).toBe("after an interruption: aborted its rebase");
    expect(saved()).toMatchObject({ attempts: 2, fixedSha: before });
    expect(saved()?.working).toBeUndefined();
    expect(gitPr.mock.calls[0]?.[0]).toMatchObject({ forceWithLease: before });
  });

  test("after an interrupted CI fix: its changes are stashed, not lost", async () => {
    writeFileSync(join(entry.worktree, "half.txt"), "half a fix\n");
    saveEntry(config.stateDir, { ...entry, working: "ci" });
    view({ statusCheckRollup: [{ status: "IN_PROGRESS" }] });
    await once();
    expect(sh(entry.worktree, "status", "--porcelain")).toBe("");
    expect(sh(entry.worktree, "stash", "list")).toContain(`pi-git: interrupted ci fix of PR #${n}`);
    expect(saved()?.notes).toEqual(["after an interruption: stashed the changes of its fix (git stash list)"]);
  });

  test("a fix that breaks off is not counted for its head, and is tried again", async () => {
    gitPr.mockRejectedValueOnce(new Error("boom"));
    view({ statusCheckRollup: [red] });
    await once();
    expect(logs).toContain(`o__r__${n}: boom`);
    expect(saved()).toMatchObject({ attempts: 1, working: "ci" });
    expect(saved()?.fixedSha).toBeUndefined();
    await once();
    expect(saved()?.notes).toContain("after an interruption: stashed the changes of its fix (git stash list)");
    expect(saved()).toMatchObject({ attempts: 2, fixedSha: head() });
    expect(gitPr).toHaveBeenCalledTimes(2);
  });

  test("an interruption with a clean worktree, or without a worktree", async () => {
    saveEntry(config.stateDir, { ...entry, working: "ci" });
    view({ statusCheckRollup: [{ status: "IN_PROGRESS" }] });
    await once();
    expect(saved()?.notes).toEqual(["after an interruption: nothing to clean up"]);
    saveEntry(config.stateDir, { ...entry, working: "ci", worktree: join(root, "gone") });
    await once();
    expect(texts().join("\n")).toContain("has no worktree any more");
  });

  test("a PR that needs the user is on the attention list until it is answered", async () => {
    saveEntry(config.stateDir, { ...entry, attempts: 2 });
    view({ statusCheckRollup: [red] });
    await once();
    expect(listAttention(config.stateDir).map((item) => [item.kind, item.repo])).toEqual([["watcher", "o/r"]]);
    expect(listAttention(config.stateDir)[0]?.text).toContain("needs you: CI still fails after 2 fixes");
    // The PR is queued again (git_pr after a fix by hand) and turns green: answered.
    saveEntry(config.stateDir, { ...entry, attempts: 0 });
    view({ statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }] });
    await once();
    expect(listAttention(config.stateDir)).toEqual([]);
  });

  test("a lock that holds back a fix needs the user too", async () => {
    config = { ...config, locked: true };
    view({ statusCheckRollup: [red] });
    await once();
    expect(listAttention(config.stateDir)[0]?.text).toContain("but git changes are locked in o/r");
    view({ state: "MERGED" });
    await once();
    expect(listAttention(config.stateDir)).toEqual([]);
  });

  test("merged: a branch that GitHub deleted already is left alone; a failing delete is reported", async () => {
    sh(main, "push", "-q", "origin", "--delete", entry.branch);
    view({ state: "MERGED" });
    await once();
    expect(texts()[0]).toMatch(/and the branch feat\/t\d+\.$/);
    expect(readFileSync(ghLog, "utf8")).not.toContain("api -X DELETE");
  });

  test("merged: the delete on GitHub fails", async () => {
    writeFileSync(join(root, "gh.apifail"), "");
    view({ state: "MERGED" });
    await once();
    rmSync(join(root, "gh.apifail"));
    expect(texts()[0]).toContain("; the branch on GitHub could not be deleted (no permission)");
  });
});

describe("a stacked PR whose base was merged", () => {
  test("rebases only its own commits on the new base, with a lease, without a report", async () => {
    // The base branch feat/base<n> has one commit; this PR's branch builds on it with one more.
    const baseBranch = `feat/base${n}`;
    const wt = entry.worktree;
    sh(wt, "reset", "-q", "--hard", "origin/main");
    writeFileSync(join(wt, "base.txt"), "base\n");
    sh(wt, "add", "-A");
    sh(wt, "commit", "-q", "-m", "base work");
    sh(wt, "push", "-q", "origin", `HEAD:${baseBranch}`);
    const baseTip = head();
    writeFileSync(join(wt, "top.txt"), "top\n");
    sh(wt, "add", "-A");
    sh(wt, "commit", "-q", "-m", "top work");
    sh(wt, "push", "-q", "-f", "origin", `HEAD:${entry.branch}`);
    saveEntry(config.stateDir, { ...entry, base: baseBranch });
    // Round 1: the PR is on the base branch; the watcher remembers the base's tip.
    view({ baseRefName: baseBranch, baseRefOid: baseTip });
    await once();
    expect(saved()?.baseSha).toBe(baseTip);
    // The base is squash-merged into main, and GitHub moves the PR to main.
    sh(main, "fetch", "-q", "origin");
    sh(main, "checkout", "-q", "--detach", "origin/main");
    writeFileSync(join(main, "base.txt"), "base\n");
    sh(main, "add", "-A");
    sh(main, "commit", "-q", "-m", "base work (#1)");
    sh(main, "push", "-q", "origin", "HEAD:main");
    const before = head();
    view({ baseRefName: "main", baseRefOid: sh(main, "rev-parse", "HEAD") });
    await once();
    expect(sh(wt, "log", "--format=%s", "-2").split("\n")).toEqual(["top work", "base work (#1)"]);
    expect(gitPr.mock.calls[0]?.[0]).toMatchObject({ base: "main", forceWithLease: before, updatePr: false });
    expect(saved()?.base).toBe("main");
    expect(saved()?.notes.at(-1)).toBe(`the base ${baseBranch} was merged; rebased the PR's own commits on main`);
    // Only the green report of round 1; the rebase itself is not reported.
    expect(texts().join("\n")).not.toMatch(/rebase|needs you/);
  });

  test("locked: waits for an unlock", async () => {
    saveEntry(config.stateDir, { ...entry, base: "feat/gone" });
    config = { ...config, locked: true };
    view({ baseRefName: "main" });
    await once();
    expect(texts().join("\n")).toContain("git changes are locked");
  });
});
