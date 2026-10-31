import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import type { Runner } from "./exec.ts";
import { run } from "./exec.ts";
import { commitStyle, findPullRequest, inspectWorktree, prNumber, repoName, repoSlug } from "./git.ts";

describe("repoName", () => {
  test.each([
    ["git@github.com:Owner/repo.git", "repo"],
    ["https://github.com/owner/repo", "repo"],
    ["https://github.com/owner/repo.git/", "repo"],
    ["git@host:repo", "repo"],
  ])("%s", (url, name) => {
    expect(repoName(url)).toBe(name);
  });
});

describe("repoSlug", () => {
  test.each([
    ["git@github.com:Owner/repo.git", "Owner/repo"],
    ["https://github.com/owner/repo/", "owner/repo"],
    ["ssh://git@github.com/owner/repo.git", "owner/repo"],
  ])("%s", (url, slug) => {
    expect(repoSlug(url)).toBe(slug);
  });
});

describe("prNumber", () => {
  test("from a URL", () => {
    expect(prNumber("https://github.com/o/r/pull/12")).toBe(12);
    expect(prNumber("nope")).toBeUndefined();
  });
});

const fake =
  (answers: Record<string, { code: number; stdout: string }>): Runner =>
  async (command, args) => {
    const answer = answers[`${command} ${args.join(" ")}`] ?? { code: 1, stdout: "" };
    return { ...answer, stderr: "" };
  };

describe("findPullRequest", () => {
  const view = "gh pr view b --json number,url,title,body,baseRefName,state";
  test("open, closed, none, garbage", async () => {
    const open = { number: 1, url: "u", title: "t", body: "", baseRefName: "main", state: "OPEN" };
    expect(await findPullRequest(fake({ [view]: { code: 0, stdout: JSON.stringify(open) } }), "/", "b")).toEqual(open);
    expect(
      await findPullRequest(
        fake({ [view]: { code: 0, stdout: JSON.stringify({ ...open, state: "MERGED" }) } }),
        "/",
        "b",
      ),
    ).toBeUndefined();
    expect(await findPullRequest(fake({}), "/", "b")).toBeUndefined();
    expect(await findPullRequest(fake({ [view]: { code: 0, stdout: "{" } }), "/", "b")).toBeUndefined();
  });
});

describe("inspectWorktree", () => {
  test("default branch from gh, else main", async () => {
    const base = {
      "git rev-parse --show-toplevel": { code: 0, stdout: "/w\n" },
      "git rev-parse --path-format=absolute --git-dir": { code: 0, stdout: "/m/.git/worktrees/w" },
      "git rev-parse --path-format=absolute --git-common-dir": { code: 0, stdout: "/m/.git" },
      "git remote get-url origin": { code: 0, stdout: "git@github.com:o/repo.git" },
      "git symbolic-ref --short -q HEAD": { code: 0, stdout: "trunk" },
    };
    const gh = "gh repo view --json defaultBranchRef --jq .defaultBranchRef.name";
    expect(await inspectWorktree(fake({ ...base, [gh]: { code: 0, stdout: "trunk\n" } }), "/w")).toContain(
      "is on the default branch trunk",
    );
    expect(await inspectWorktree(fake(base), "/w")).toEqual({
      root: "/w",
      branch: "trunk",
      defaultBranch: "main",
      repo: "repo",
      slug: "o/repo",
      mainRoot: "/m",
    });
    const noOrigin = { ...base, "git remote get-url origin": { code: 2, stdout: "" } };
    expect(await inspectWorktree(fake(noOrigin), "/w")).toBe('/w has no remote "origin"');
  });
});

describe("commitStyle", () => {
  beforeAll(() => {
    for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];
  });

  function repo(files: Record<string, string>): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-git-style-")));
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))),
      GIT_CONFIG_NOSYSTEM: "1",
    };
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, env });
    git("init", "-q", "-b", "main");
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", "area: first");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    return dir;
  }

  test("conventional by release-please, by a hook in devenv.nix, or not", async () => {
    expect(await commitStyle(run, repo({ "release-please-config.json": "{}" }), "main")).toEqual({
      conventional: true,
      recent: ["area: first"],
    });
    expect((await commitStyle(run, repo({ "devenv.nix": "convco.enable = true;" }), "main")).conventional).toBe(true);
    expect((await commitStyle(run, repo({ "devenv.nix": "{ }" }), "main")).conventional).toBe(false);
    expect(await commitStyle(run, repo({}), "nope")).toEqual({ conventional: false, recent: [] });
  });
});
