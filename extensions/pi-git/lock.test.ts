import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  describeLock,
  gitCompletions,
  lockedReason,
  lockPrompt,
  parseGitCommand,
  type States,
  statesOf,
  statusText,
} from "./lock.ts";
import { setGlobal, setRepo } from "./switch.ts";

const all = (lock: "locked" | "unlocked"): States => ({ worktree: lock, commit: lock, push: lock, pr: lock });

describe("texts", () => {
  test("statusText", () => {
    expect(statusText(all("locked"))).toBe("git: locked");
    expect(statusText(all("unlocked"))).toBe("git: unlocked");
    expect(statusText({ ...all("locked"), commit: "unlocked", push: "unlocked" })).toBe("git: commit, push unlocked");
  });

  test("lockedReason", () => {
    expect(lockedReason("push", "git push", "o/r")).toBe(
      "pi-git: push is locked in o/r (git push). Only the user can allow it: /git unlock push, or /git push for one time.",
    );
    expect(lockedReason("commit", "git init", undefined)).toContain("locked outside a repository with an origin");
  });

  test("lockPrompt: all locked, mixed, all unlocked", () => {
    const locked = lockPrompt(all("locked"), "o/r");
    expect(locked).toMatch(/^git: locked in o\/r\.\nBlocked for you:\n- worktree: /);
    expect(locked).toContain(
      "ask the\nuser to run /git unlock <step>, or /git <step> for one time; only the user can.",
    );
    expect(locked).not.toContain("Allowed:");
    const mixed = lockPrompt({ ...all("locked"), commit: "unlocked" }, undefined);
    expect(mixed).toMatch(/^git: commit unlocked here \(not in a repository with an origin\)\.\nAllowed: commit\./);
    expect(mixed).toContain("- push: pushing");
    const open = lockPrompt(all("unlocked"), "o/r");
    expect(open).not.toContain("Blocked");
    expect(open).toContain("Allowed: worktree, commit, push, pr.");
  });

  test("statesOf and describeLock", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-git-lock-"));
    setGlobal(dir, ["commit"], "unlocked");
    setRepo(dir, "o/r", ["push"], "unlocked");
    expect(statesOf(dir, "o/r", "locked")).toEqual({
      worktree: "locked",
      commit: "unlocked",
      push: "unlocked",
      pr: "locked",
    });
    const text = describeLock(dir, "o/r", "locked");
    expect(text).toContain(
      "git in o/r:\n  worktree locked   (default)\n  commit   unlocked (global)\n  push     unlocked (this repository)",
    );
    expect(text).toContain('overrides:\n  o/r: {"push":"unlocked"}');
    expect(describeLock(mkdtempSync(join(tmpdir(), "pi-git-lock-")), undefined, "locked")).toMatch(/^git here:/);
  });
});

describe("parseGitCommand", () => {
  test.each([
    ["", { kind: "show" }],
    ["unlock", { kind: "set", scope: "repo", steps: [], lock: "unlocked" }],
    ["lock push pr", { kind: "set", scope: "repo", steps: ["push", "pr"], lock: "locked" }],
    ["reset commit", { kind: "set", scope: "repo", steps: ["commit"], lock: undefined }],
    ["global unlock commit", { kind: "set", scope: "global", steps: ["commit"], lock: "unlocked" }],
    ["global reset", { kind: "set", scope: "global", steps: [], lock: undefined }],
    ["commit", { kind: "run", step: "commit", intent: "" }],
    ["commit  fix the  docs", { kind: "run", step: "commit", intent: "fix the docs" }],
    ["unlock nope", { kind: "bad" }],
    ["global", { kind: "bad" }],
    ["maybe", { kind: "bad" }],
  ])("%j", (args, command) => {
    expect(parseGitCommand(args)).toEqual(command);
  });

  test("completions", () => {
    expect(gitCompletions("unlock p").map((item) => item.value)).toEqual(["unlock push", "unlock pr"]);
    expect(gitCompletions("co").map((item) => item.value)).toEqual(["commit"]);
  });
});
