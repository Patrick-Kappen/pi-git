import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { addAttention } from "./attention.ts";
import { type Runner, run } from "./exec.ts";
import { loadEntries } from "./state.ts";
import { gitStatus, gitWatch, type StatusDeps } from "./status.ts";

const home = realpathSync(mkdtempSync(join(tmpdir(), "pi-git-status-")));
const stateDir = join(home, "state");
const origin = join(home, "origin", "o", "demo.git");
const main = join(home, "private", "demo");
const trees = join(home, ".worktrees", "demo");
const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

beforeAll(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];
  mkdirSync(origin, { recursive: true });
  g(origin, "init", "-q", "--bare", "-b", "main");
  mkdirSync(main, { recursive: true });
  g(main, "init", "-q", "-b", "main");
  g(main, "config", "user.email", "t@t");
  g(main, "config", "user.name", "t");
  writeFileSync(join(main, "a.txt"), "a\n");
  g(main, "add", ".");
  g(main, "commit", "-q", "-m", "first");
  g(main, "remote", "add", "origin", `file://${origin}`);
  g(main, "push", "-q", "-u", "origin", "main");
  g(main, "worktree", "add", "-q", "-b", "feat/pushed", join(trees, "pushed"), "main");
  g(join(trees, "pushed"), "push", "-q", "-u", "origin", "feat/pushed");
  g(main, "worktree", "add", "-q", "-b", "feat/local", join(trees, "local"), "main");
  writeFileSync(join(trees, "local", "b.txt"), "b\n");
});

// gh is faked: PR 7 is open on feat/pushed, PR 8 on a branch without worktree, PR 9 is merged.
const prs: Record<string, object> = {
  "7": {
    number: 7,
    url: "https://github.com/o/demo/pull/7",
    title: "feat: pushed",
    state: "OPEN",
    headRefName: "feat/pushed",
    baseRefName: "main",
  },
  "8": { number: 8, url: "u8", title: "t", state: "OPEN", headRefName: "feat/elsewhere", baseRefName: "main" },
  "9": { number: 9, url: "u9", title: "t", state: "MERGED", headRefName: "feat/pushed", baseRefName: "main" },
};
const fake: Runner = async (command, args, options) => {
  if (command !== "gh") return run(command, args, options);
  const pr = prs[args[2] ?? ""];
  return pr
    ? { code: 0, stdout: JSON.stringify(pr), stderr: "" }
    : { code: 1, stdout: "", stderr: "no pull requests found" };
};
const deps: StatusDeps = { run: fake, config: { worktrees: "~/.worktrees", stateDir }, home };

describe("gitWatch", () => {
  test("queues an open PR with its worktree", async () => {
    const result = await gitWatch(deps, { pr: "7", path: main, sessionId: "s1" }, new Date("2026-01-01T00:00:00Z"));
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("The watcher follows o/demo#7");
    expect(loadEntries(stateDir)).toEqual([
      expect.objectContaining({
        repo: "o/demo",
        number: 7,
        worktree: join(trees, "pushed"),
        mainRoot: main,
        branch: "feat/pushed",
        base: "main",
        intent: "feat: pushed",
        sessionId: "s1",
        status: "watching",
      }),
    ]);
  });

  test.each([
    ["8", /no worktree has feat\/elsewhere checked out/],
    ["9", /PR #9 is merged/],
    ["404", /gh pr view 404 failed: no pull requests found/],
  ])("PR %s is refused", async (pr, message) => {
    const result = await gitWatch(deps, { pr, path: main, sessionId: "s1" });
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(message);
  });

  test("outside a repository", async () => {
    expect((await gitWatch(deps, { pr: "7", path: home, sessionId: "s" })).summary).toMatch(/not in a git repository/);
  });
});

describe("gitStatus", () => {
  test("lists watched PRs, what needs the user, and the worktrees", async () => {
    addAttention(stateDir, { kind: "request", repo: "o/demo", text: "o/demo: needs a decision" });
    const text = await gitStatus(deps);
    expect(text).toContain("Watched PRs:\n- o/demo#7 watching: https://github.com/o/demo/pull/7");
    expect(text).toContain("Needs the user:\n- o/demo: needs a decision");
    expect(text).toContain("- demo/local (feat/local): 1 uncommitted, not pushed, no PR in the watcher");
    expect(text).toContain("- demo/pushed (feat/pushed): PR #7 watching");
  });

  test("caps the worktree lines", async () => {
    const many = realpathSync(mkdtempSync(join(tmpdir(), "pi-git-many-")));
    for (let i = 0; i < 42; i++) {
      mkdirSync(join(many, "trees", "r", `t${String(i).padStart(2, "0")}`, ".git"), { recursive: true });
    }
    const quiet: Runner = async () => ({ code: 1, stdout: "", stderr: "" });
    const text = await gitStatus({
      run: quiet,
      config: { worktrees: join(many, "trees"), stateDir: join(many, "s") },
      home: many,
    });
    expect(text).toContain("- and 2 more");
    expect(text.split("\n").filter((line) => line.startsWith("- r/"))).toHaveLength(40);
  });

  test("nothing in progress", async () => {
    const empty = realpathSync(mkdtempSync(join(tmpdir(), "pi-git-empty-")));
    const text = await gitStatus({
      run,
      config: { worktrees: join(empty, "trees"), stateDir: join(empty, "s") },
      home: empty,
    });
    expect(text).toBe(`Watched PRs: none\n\nWorktrees: none in ${join(empty, "trees")}`);
  });
});
