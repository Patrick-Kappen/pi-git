import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { type Runner, run } from "./exec.ts";
import { findMainCheckout, gitStart, type StartDeps, type StartInput, setupCommand } from "./start.ts";

const home = realpathSync(mkdtempSync(join(tmpdir(), "pi-git-start-")));
const origin = join(home, "origin", "o", "demo.git");
const main = join(home, "private", "demo");
const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

beforeAll(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];
  mkdirSync(origin, { recursive: true });
  g(origin, "init", "-q", "--bare", "-b", "main");
  mkdirSync(main, { recursive: true });
  g(main, "init", "-q", "-b", "main");
  g(main, "config", "user.email", "t@t");
  g(main, "config", "user.name", "t");
  writeFileSync(join(main, "release-please-config.json"), "{}\n");
  writeFileSync(join(main, "CONTRIBUTING.md"), "# c\n");
  g(main, "add", ".");
  g(main, "commit", "-q", "-m", "feat: first");
  g(main, "remote", "add", "origin", `file://${origin}`);
  // `o/demo` as the slug: the remote URL ends in o/demo.git.
  g(main, "push", "-q", "-u", "origin", "main");
  g(main, "remote", "set-head", "origin", "main");
  g(main, "switch", "-q", "-c", "fix/remote-only");
  g(main, "push", "-q", "origin", "fix/remote-only");
  g(main, "switch", "-q", "main");
  g(main, "branch", "-q", "-D", "fix/remote-only");
});

const steps: string[] = [];
const deps = (runner: Runner = run): StartDeps => ({
  run: runner,
  config: { worktrees: "~/.worktrees", checkTimeout: 60 },
  home,
  progress: (step) => steps.push(step),
});
const start = (input: Partial<StartInput>, runner?: Runner) =>
  gitStart({ repo: "demo", topic: "login", type: "feat", ...input }, deps(runner));

describe("findMainCheckout", () => {
  test("by name, by owner/name, and from a directory", async () => {
    expect(await findMainCheckout(deps(), "demo")).toBe(main);
    expect(await findMainCheckout(deps(), "o/demo")).toBe(main);
    expect(await findMainCheckout(deps(), "~/private/demo")).toBe(main);
  });
  test("a wrong owner or an unknown name is an error", async () => {
    expect(await findMainCheckout(deps(), "other/demo")).toMatchObject({ error: /no main checkout of other\/demo/ });
    expect(await findMainCheckout(deps(), "/nonexistent/dir")).toMatchObject({ error: /not in a git repository/ });
  });
});

describe("gitStart", () => {
  test("creates the worktree from the fresh default branch and reports the facts", async () => {
    const result = await start({ setup: false });
    const path = join(home, ".worktrees", "demo", "login");
    expect(result).toMatchObject({ ok: true, path, branch: "feat/login", slug: "o/demo" });
    expect(g(path, "symbolic-ref", "--short", "HEAD")).toBe("feat/login");
    // No upstream yet: git_pr pushes with -u.
    expect(() => g(path, "rev-parse", "--abbrev-ref", "@{u}")).toThrow();
    expect(result.summary).toContain("Default branch: main");
    expect(result.summary).toContain('Commits: Conventional Commits; recent: "feat: first"');
    expect(result.summary).toContain("Read: CONTRIBUTING.md");
  });

  test("a second call with the same topic returns the existing worktree", async () => {
    const result = await start({ setup: false });
    expect(result.summary).toMatch(/already exists/);
  });

  test("lists the other worktrees, and continues a branch that exists only on origin", async () => {
    const result = await start({ topic: "remote-only", type: "fix", setup: false });
    expect(result.summary).toContain("continues origin/fix/remote-only");
    expect(result.summary).toMatch(/Other worktrees: .*login \(feat\/login\)/);
  });

  test("a stacked change names its base", async () => {
    const result = await start({ topic: "stacked", base: "fix/remote-only", setup: false });
    expect(result.summary).toContain("base: fix/remote-only (stacked: open the PR with base fix/remote-only)");
  });

  test.each([
    [{ type: "feature" }, /type must be one of/],
    [{ topic: "Bad Topic" }, /topic: lower case/],
    [{ base: "nope" }, /origin\/nope does not exist/],
    [{ repo: "missing" }, /no main checkout/],
  ])("%j is refused", async (input, message) => {
    const result = await start({ topic: "refused", setup: false, ...input });
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(message);
  });

  test("an existing local branch is refused", async () => {
    g(main, "branch", "feat/taken", "main");
    expect((await start({ topic: "taken", setup: false })).summary).toMatch(/exists already/);
  });

  test("a directory on another branch is refused", async () => {
    mkdirSync(join(home, ".worktrees", "demo", "busy"), { recursive: true });
    expect((await start({ topic: "busy", setup: false })).summary).toMatch(/exists; pick another topic/);
  });

  test("runs the setup, and reports a failing one without failing the start", async () => {
    const fake: Runner = async (command, args, options) =>
      command === "npm" ? { code: 1, stdout: "", stderr: "npm ERR! missing lock" } : run(command, args, options);
    writeFileSync(join(main, "package-lock.json"), "{}\n");
    g(main, "add", ".");
    g(main, "commit", "-q", "-m", "chore: lock");
    g(main, "push", "-q");
    const result = await start({ topic: "with-setup" }, fake);
    expect(result.ok).toBe(true);
    expect(result.summary).toContain(
      "Setup: `npm ci` failed; run it in the worktree before the checks:\nnpm ERR! missing lock",
    );
    const ok: Runner = async (command, args, options) =>
      command === "npm" ? { code: 0, stdout: "", stderr: "" } : run(command, args, options);
    expect((await start({ topic: "with-setup-ok" }, ok)).summary).toContain("Setup: `npm ci` done");
  });

  test("a failing fetch stops", async () => {
    const fake: Runner = async (command, args, options) =>
      args[0] === "fetch" ? { code: 1, stdout: "", stderr: "no network" } : run(command, args, options);
    expect((await start({ topic: "offline", setup: false }, fake)).summary).toMatch(/git fetch failed:\nno network/);
  });
});

describe("setupCommand", () => {
  test("devenv first, then npm, then uv, else none", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-git-setup-"));
    expect(setupCommand(dir)).toBeUndefined();
    writeFileSync(join(dir, "uv.lock"), "");
    expect(setupCommand(dir)).toEqual(["uv", "sync"]);
    writeFileSync(join(dir, "devenv.nix"), "");
    expect(setupCommand(dir)).toEqual(["devenv", "shell", "--", "true"]);
    expect(existsSync(dir)).toBe(true);
  });
});
