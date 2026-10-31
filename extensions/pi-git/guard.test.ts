import { describe, expect, test } from "vitest";
import { blockedForHelper, commandsOf, ghWrites, gitChanges, gitWrites } from "./guard.ts";

describe("commandsOf", () => {
  test("splits lines and strips prefixes", () => {
    expect(commandsOf("npm test && git -C 'a b' commit -m \"x; y\" | cat")).toEqual([
      ["npm", "test"],
      ["git", "-C", "a b", "commit", "-m", "x; y"],
      ["cat"],
    ]);
    expect(commandsOf("FOO=1 sudo git push; echo $(gh pr list)")).toEqual([
      ["git", "push"],
      ["echo"],
      ["gh", "pr", "list"],
    ]);
    expect(commandsOf("  ")).toEqual([]);
    expect(commandsOf("a ;; b")).toEqual([["a"], ["b"]]);
    expect(commandsOf("X=1")).toEqual([]);
  });
});

describe("blockedForHelper", () => {
  test.each([
    ["git commit -m x", "git commit"],
    ["npm test && git push", "git push"],
    ["git -C /x -c a=b rebase main", "git rebase"],
    ["/usr/bin/git add -A", "git add"],
    ["gh pr merge 1", "gh"],
    ["echo $(git stash)", "git stash"],
  ])("%s", (line, blocked) => {
    expect(blockedForHelper(line)).toBe(blocked);
  });

  test.each([
    ["git status"],
    ["git diff --cached"],
    ["git log -5"],
    ["git -C x show HEAD"],
    ["git"],
    ["npm test"],
    ["echo git push"],
  ])("allowed: %s", (line) => {
    expect(blockedForHelper(line)).toBeUndefined();
  });
});

describe("gitWrites", () => {
  test.each([
    ["status", []],
    ["log", ["-5"]],
    ["fetch", ["origin"]],
    ["branch", []],
    ["branch", ["-a", "--contains", "abc"]],
    ["branch", ["--list", "feat/*"]],
    ["tag", ["-l"]],
    ["remote", ["-v"]],
    ["remote", ["get-url", "origin"]],
    ["stash", ["list"]],
    ["worktree", ["list"]],
    ["reflog", []],
    ["config", ["--get", "user.name"]],
    ["config", ["user.name"]],
  ])("reads: git %s %j", (sub, args) => {
    expect(gitWrites(sub, args)).toBe(false);
  });

  test.each([
    ["commit", ["-m", "x"]],
    ["push", []],
    ["add", ["-A"]],
    ["checkout", ["main"]],
    ["branch", ["new"]],
    ["branch", ["-D", "old"]],
    ["tag", ["v1"]],
    ["tag", ["-a", "v1", "-m", "x"]],
    ["remote", ["add", "x", "y"]],
    ["stash", []],
    ["worktree", ["add", "x"]],
    ["config", ["user.name", "x"]],
    ["init", []],
  ])("writes: git %s %j", (sub, args) => {
    expect(gitWrites(sub, args)).toBe(true);
  });
});

describe("ghWrites", () => {
  test.each([
    [[]],
    [["pr", "view", "1"]],
    [["pr", "checks", "-R", "o/r"]],
    [["run", "view", "1", "--log-failed"]],
    [["search", "repos", "x"]],
    [["api", "repos/o/r"]],
    [["api", "-X", "GET", "x"]],
  ])("reads: %j", (args) => {
    expect(ghWrites(args)).toBe(false);
  });

  test.each([
    [["pr", "create"]],
    [["pr", "merge", "1"]],
    [["repo", "create", "x"]],
    [["api", "-X", "POST", "x"]],
    [["api", "x", "-f", "a=b"]],
    [["api", "--method=DELETE", "x"]],
    [["api", "-XPATCH", "x"]],
  ])("writes: %j", (args) => {
    expect(ghWrites(args)).toBe(true);
  });
});

describe("jj", () => {
  test("changes and their steps; reading commands are free", () => {
    expect(gitChanges("jj git push -b x; jj --at-op abc commit -m y; jj workspace add ../w", "/w", "/h")).toEqual([
      { what: "jj git push", step: "push", dir: "/w" },
      { what: "jj commit", step: "commit", dir: "/w" },
      { what: "jj workspace add", step: "worktree", dir: "/w" },
    ]);
    expect(gitChanges("jj -R ~/r bookmark set b -r @-; jj describe -m x", "/w", "/h")).toEqual([
      { what: "jj bookmark set", step: "worktree", dir: "/h/r" },
      { what: "jj describe", step: "commit", dir: "/w" },
    ]);
    expect(gitChanges("jj git remote add o url", "/w", "/h")).toEqual([
      { what: "jj git remote", step: "commit", dir: "/w" },
    ]);
    expect(
      gitChanges(
        "jj log -r @; jj st; jj diff; jj bookmark list; jj git fetch; jj git remote list; jj op log; jj workspace list; jj --color never show; jj",
        "/w",
        "/h",
      ),
    ).toEqual([]);
  });

  test("the helper may read with jj, not change", () => {
    expect(blockedForHelper("jj diff && jj log")).toBeUndefined();
    expect(blockedForHelper("jj squash")).toBe("jj squash");
    expect(blockedForHelper("jj git push")).toBe("jj git push");
  });
});

describe("gitChanges", () => {
  test("directories from cd and -C, the repository from gh -R, and the step", () => {
    expect(gitChanges("git status && git commit -m x", "/w", "/home/u")).toEqual([
      { what: "git commit", step: "commit", dir: "/w" },
    ]);
    expect(gitChanges("cd ../other && git push; cd ~/x && git -C sub add .", "/w", "/home/u")).toEqual([
      { what: "git push", step: "push", dir: "/w/../other" },
      { what: "git add", step: "commit", dir: "/home/u/x/sub" },
    ]);
    expect(gitChanges("cd /abs && cd && git -c a=b commit", "/w", "/home/u")).toEqual([
      { what: "git commit", step: "commit", dir: "/home/u" },
    ]);
    expect(gitChanges("git worktree add x && git branch -D y", "/w", "/h").map((change) => change.step)).toEqual([
      "worktree",
      "worktree",
    ]);
    expect(gitChanges("gh pr create -R o/r --title x", "/w", "/h")).toEqual([
      { what: "gh pr create", step: "pr", dir: "/w", slug: "o/r" },
    ]);
    expect(gitChanges("gh --repo=o/r pr merge 1", "/w", "/h")).toEqual([
      { what: "gh pr merge", step: "pr", dir: "/w", slug: "o/r" },
    ]);
    expect(gitChanges("gh pr list; git log; git; ls", "/w", "/h")).toEqual([]);
    expect(gitChanges("git -C ~ commit && git -C", "/w", "/h")).toEqual([
      { what: "git commit", step: "commit", dir: "/h" },
    ]);
  });
});
