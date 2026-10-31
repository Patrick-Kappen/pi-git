import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { effective, loadSwitch, setGlobal, setRepo, switchPath } from "./switch.ts";

const fresh = () => mkdtempSync(join(tmpdir(), "pi-git-switch-"));

describe("switch", () => {
  test("per step: default, global, repo override", () => {
    const dir = fresh();
    expect(loadSwitch(dir)).toEqual({ global: {}, repos: {} });
    expect(effective(loadSwitch(dir), "o/r", "commit", "locked")).toEqual({ lock: "locked", source: "default" });
    setGlobal(dir, ["commit"], "unlocked");
    expect(effective(loadSwitch(dir), "o/r", "commit", "locked")).toEqual({ lock: "unlocked", source: "global" });
    expect(effective(loadSwitch(dir), "o/r", "push", "locked")).toEqual({ lock: "locked", source: "default" });
    setRepo(dir, "O/R", ["commit"], "locked");
    expect(effective(loadSwitch(dir), "o/r", "commit", "unlocked")).toEqual({ lock: "locked", source: "repo" });
    expect(effective(loadSwitch(dir), "o/r", "push", "unlocked")).toEqual({ lock: "unlocked", source: "default" });
    expect(effective(loadSwitch(dir), undefined, "commit", "locked")).toEqual({ lock: "unlocked", source: "global" });
  });

  test("no steps means every step; reset removes; keys are case-insensitive", () => {
    const dir = fresh();
    setRepo(dir, "Owner/Repo", [], "unlocked");
    expect(loadSwitch(dir).repos).toEqual({
      "Owner/Repo": { worktree: "unlocked", commit: "unlocked", push: "unlocked", pr: "unlocked" },
    });
    setRepo(dir, "owner/repo", ["push", "pr"], "locked");
    expect(loadSwitch(dir).repos).toEqual({
      "owner/repo": { worktree: "unlocked", commit: "unlocked", push: "locked", pr: "locked" },
    });
    setRepo(dir, "OWNER/REPO", ["push"], undefined);
    expect(loadSwitch(dir).repos).toEqual({ "OWNER/REPO": { worktree: "unlocked", commit: "unlocked", pr: "locked" } });
    setRepo(dir, "owner/repo", [], undefined);
    expect(loadSwitch(dir).repos).toEqual({});
    setGlobal(dir, [], "locked");
    setGlobal(dir, ["commit"], undefined);
    expect(loadSwitch(dir).global).toEqual({ worktree: "locked", push: "locked", pr: "locked" });
  });

  test("old and odd files", () => {
    const dir = fresh();
    writeFileSync(switchPath(dir), "{");
    expect(loadSwitch(dir)).toEqual({ global: {}, repos: {} });
    writeFileSync(
      switchPath(dir),
      JSON.stringify({
        global: "unlocked",
        repos: { "a/b": "locked", "c/d": 1, "e/f": { push: "unlocked", x: "locked", pr: 2 } },
      }),
    );
    expect(loadSwitch(dir)).toEqual({
      global: { worktree: "unlocked", commit: "unlocked", push: "unlocked", pr: "unlocked" },
      repos: {
        "a/b": { worktree: "locked", commit: "locked", push: "locked", pr: "locked" },
        "e/f": { push: "unlocked" },
      },
    });
    writeFileSync(switchPath(dir), "null");
    expect(loadSwitch(dir)).toEqual({ global: {}, repos: {} });
  });
});
