import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { defaults } from "./config.ts";
import { type Runner, run } from "./exec.ts";
import { gitWorktree, setupCommand } from "./worktree.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-git-worktree-")));
const origin = join(root, "origin.git");
const main = join(root, "project");
const worktrees = join(root, "worktrees");
const bin = join(root, "bin");

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

beforeAll(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];
  const gitconfig = join(root, "gitconfig");
  writeFileSync(gitconfig, "[user]\n\tname = t\n\temail = t@t\n[init]\n\tdefaultBranch = main\n");
  process.env.GIT_CONFIG_GLOBAL = gitconfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  execFileSync("git", ["init", "-q", "--bare", origin]);
  execFileSync("git", ["clone", "-q", origin, main]);
  writeFileSync(join(main, "package-lock.json"), "{}\n");
  sh(main, "add", "-A");
  sh(main, "commit", "-q", "-m", "start");
  sh(main, "push", "-q", "origin", "main");
  sh(main, "remote", "set-head", "origin", "main");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    `#!/bin/sh\nif [ -f FAIL ]; then echo "npm broke" >&2; exit 1; fi\necho "$*" > npm.log\n`,
  );
  chmodSync(join(bin, "npm"), 0o755);
});

const config = { ...defaults("p", {}, root), worktrees };
const runner: Runner = (command, args, options) => run(command === "npm" ? join(bin, "npm") : command, args, options);
const steps: string[] = [];
const create = (input: { topic: string; type?: string; base?: string; path?: string }) =>
  gitWorktree({ path: input.path ?? main, ...input }, { run: runner, config, progress: (step) => steps.push(step) });

describe("gitWorktree", () => {
  test("creates <worktrees>/<repo>/<topic> on <type>/<topic> from origin/main, and runs the setup", async () => {
    const result = await create({ topic: "login-timeout", type: "fix" });
    const dir = join(worktrees, "origin", "login-timeout");
    expect(result).toMatchObject({ ok: true, path: dir, branch: "fix/login-timeout" });
    expect(result.summary).toContain(
      `Created the worktree ${dir} on fix/login-timeout from origin/main. Setup done (npm ci --ignore-scripts --no-audit --no-fund).`,
    );
    expect(sh(dir, "branch", "--show-current")).toBe("fix/login-timeout");
    expect(existsSync(join(dir, "npm.log"))).toBe(true);
    expect(steps).toContain(`creating ${dir} on fix/login-timeout`);
  });

  test("from a worktree too; the default type is feat; a base branch", async () => {
    sh(main, "push", "-q", "origin", "main:refs/heads/release");
    const first = await create({ topic: "one" });
    expect(first.branch).toBe("feat/one");
    const second = await create({ topic: "two", base: "release", path: first.path as string });
    expect(second.summary).toContain("from origin/release");
    expect(second.path).toBe(join(worktrees, "origin", "two"));
  });

  test("refuses bad names, existing worktrees and branches, and places that are not repositories", async () => {
    expect((await create({ topic: "Bad Topic" })).summary).toContain('the topic "Bad Topic" must be');
    expect((await create({ topic: "x", type: "Feat!" })).summary).toContain('the type "Feat!" must be');
    expect((await create({ topic: "x", path: root })).summary).toContain("is not in a git repository");
    await create({ topic: "taken" });
    expect((await create({ topic: "taken" })).summary).toContain("exists already; pick another topic, or work there");
    sh(main, "branch", "feat/branch-only");
    expect((await create({ topic: "branch-only" })).summary).toContain("the branch feat/branch-only exists already");
    expect((await create({ topic: "nobase", base: "nope" })).summary).toContain("git fetch origin nope failed");
  });

  test("a repository without origin", async () => {
    const lonely = join(root, "lonely");
    execFileSync("git", ["init", "-q", lonely]);
    expect((await create({ topic: "x", path: lonely })).summary).toContain('has no remote "origin"');
  });

  test("a failing setup leaves the worktree", async () => {
    writeFileSync(join(main, "FAIL"), "");
    sh(main, "add", "FAIL");
    sh(main, "commit", "-q", "-m", "fail the setup");
    sh(main, "push", "-q", "origin", "main");
    const result = await create({ topic: "broken-setup" });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("failed; the worktree is there anyway:\nnpm broke");
  });
});

describe("setupCommand", () => {
  test.each<[string, [string, string[]] | undefined]>([
    ["devenv.nix", ["devenv", ["shell", "--", "true"]]],
    ["package-lock.json", ["npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]]],
    ["uv.lock", ["uv", ["sync"]]],
    ["README.md", undefined],
  ])("%s", (file, command) => {
    const dir = mkdtempSync(join(tmpdir(), "pi-git-setup-"));
    writeFileSync(join(dir, file), "");
    expect(setupCommand(dir)).toEqual(command);
  });
});
