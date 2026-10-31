import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { effective, loadSwitch, setGlobal, setRepo, switchPath } from "./switch.ts";

const fresh = () => mkdtempSync(join(tmpdir(), "pi-git-switch-"));

describe("switch", () => {
  test("default, global, repo override", () => {
    const dir = fresh();
    expect(loadSwitch(dir)).toEqual({ repos: {} });
    expect(effective(loadSwitch(dir), "o/r", "locked")).toEqual({ lock: "locked", source: "default" });
    setGlobal(dir, "unlocked");
    expect(effective(loadSwitch(dir), "o/r", "locked")).toEqual({ lock: "unlocked", source: "global" });
    setRepo(dir, "O/R", "locked");
    expect(effective(loadSwitch(dir), "o/r", "unlocked")).toEqual({ lock: "locked", source: "repo" });
    expect(effective(loadSwitch(dir), undefined, "locked")).toEqual({ lock: "unlocked", source: "global" });
  });

  test("overrides are case-insensitive, removable, and survive global changes", () => {
    const dir = fresh();
    setRepo(dir, "Owner/Repo", "unlocked");
    setRepo(dir, "owner/repo", "locked");
    expect(loadSwitch(dir)).toEqual({ repos: { "owner/repo": "locked" } });
    setGlobal(dir, "locked");
    setGlobal(dir, undefined);
    expect(loadSwitch(dir)).toEqual({ repos: { "owner/repo": "locked" } });
    setRepo(dir, "OWNER/REPO", undefined);
    expect(loadSwitch(dir)).toEqual({ repos: {} });
  });

  test("broken or odd files", () => {
    const dir = fresh();
    writeFileSync(switchPath(dir), "{");
    expect(loadSwitch(dir)).toEqual({ repos: {} });
    writeFileSync(switchPath(dir), JSON.stringify({ global: "maybe", repos: { "a/b": "unlocked", "c/d": 1 } }));
    expect(loadSwitch(dir)).toEqual({ repos: { "a/b": "unlocked" } });
    writeFileSync(switchPath(dir), "null");
    expect(loadSwitch(dir)).toEqual({ repos: {} });
  });
});
