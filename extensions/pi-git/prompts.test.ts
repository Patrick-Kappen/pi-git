import { describe, expect, test } from "vitest";
import {
  checkFixPrompt,
  ciFixPrompt,
  conflictPrompt,
  fixPrompt,
  messagePrompt,
  messageRetryPrompt,
  pullRequestPrompt,
  splitPrompt,
  summaryPrompt,
} from "./prompts.ts";

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

  test("split into logical commits", () => {
    expect(splitPrompt(true)).toContain("Split by file: every changed file in the input goes into exactly one commit.");
    expect(splitPrompt(true)).toContain("uses Conventional Commits");
    expect(splitPrompt(false)).toContain("does not use Conventional Commits");
    expect(splitPrompt(false)).not.toContain("rejected");
    expect(splitPrompt(true, "use feat:")).toMatch(/rejected a message of the previous answer:\nuse feat:$/);
  });

  test("pull request, new or updated", () => {
    expect(pullRequestPrompt(true, false)).toContain("Title: a Conventional Commit");
    expect(pullRequestPrompt(true, false)).not.toContain("Keep what is still true");
    expect(pullRequestPrompt(false, true)).toContain("Write the updated title");
    expect(pullRequestPrompt(false, true)).toContain("Keep what is still true");
  });

  test("watcher and git_check", () => {
    expect(ciFixPrompt(1, 3)).toContain("fix 1 of 3. CI fails");
    expect(conflictPrompt("main")).toContain("origin/main stopped at conflicts");
    expect(checkFixPrompt("npm test", 2, 3)).toContain(
      "attempt 2 of 3. The checks of this repository fail: `npm test`",
    );
    expect(summaryPrompt("npm test")).toContain("The checks `npm test` fail");
  });
});
