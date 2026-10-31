import { describe, expect, test } from "vitest";
import { fixPrompt, messagePrompt, messageRetryPrompt, pullRequestPrompt } from "./prompts.ts";

describe("prompts", () => {
  test("fix", () => {
    expect(fixPrompt("pre-push", 2, 3)).toMatch(
      /^You are the helper of pi-git, attempt 2 of 3\. The pre-push checks fail/,
    );
    expect(fixPrompt("commit", 1, 1)).toContain("The commit was refused by a hook");
  });

  test("commit message by style", () => {
    expect(messagePrompt(true)).toContain("uses Conventional Commits");
    expect(messagePrompt(false)).toContain("does not use Conventional Commits");
    expect(messageRetryPrompt(true, "bad")).toMatch(/rejected the previous message:\nbad$/);
  });

  test("pull request, new or updated", () => {
    expect(pullRequestPrompt(true, false)).toContain("Title: a Conventional Commit");
    expect(pullRequestPrompt(true, false)).not.toContain("Keep what is still true");
    expect(pullRequestPrompt(false, true)).toContain("Write the updated title");
    expect(pullRequestPrompt(false, true)).toContain("Keep what is still true");
  });
});
