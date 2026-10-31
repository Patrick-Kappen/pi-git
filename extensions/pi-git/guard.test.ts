import { describe, expect, test } from "vitest";
import { blockedForHelper, commandsOf } from "./guard.ts";

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
