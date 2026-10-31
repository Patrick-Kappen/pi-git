import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { backendOf, describeBackend, isBackend, loadBackends, setBackend, toBackends } from "./backend.ts";

describe("backend", () => {
  test("/git backend wins over the patterns of the config, they win over the default", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-git-backend-"));
    const settings = { "o/*": "jj", "o/plain": "git" } as const;
    expect(backendOf(dir, "o/r", settings, "git")).toEqual({ backend: "jj", source: "settings", pattern: "o/*" });
    expect(backendOf(dir, "o/plain", settings, "jj")).toEqual({
      backend: "git",
      source: "settings",
      pattern: "o/plain",
    });
    expect(backendOf(dir, "x/y", settings, "git")).toEqual({ backend: "git", source: "default" });
    expect(backendOf(dir, undefined, settings, "jj")).toEqual({ backend: "jj", source: "default" });
    setBackend(dir, "O/R", "git");
    expect(backendOf(dir, "o/r", settings, "git")).toEqual({ backend: "git", source: "repo" });
    setBackend(dir, "o/r", "jj");
    expect(loadBackends(dir)).toEqual({ "o/r": "jj" });
    setBackend(dir, "o/r", undefined);
    expect(loadBackends(dir)).toEqual({});
  });

  test("texts, parsing and a broken file", () => {
    expect(describeBackend({ backend: "jj", source: "repo" })).toBe(
      "new worktrees: jj (/git backend); /git backend git|jj|reset",
    );
    expect(describeBackend({ backend: "git", source: "settings", pattern: "o/*" })).toContain(
      '"backends" in the config (o/*)',
    );
    expect(describeBackend({ backend: "git", source: "default" })).toContain('"backend" in the config');
    expect(toBackends({ a: "jj", b: "hg", " ": "git" })).toEqual({ a: "jj" });
    expect(toBackends(["jj"])).toEqual({});
    expect([isBackend("git"), isBackend("hg")]).toEqual([true, false]);
    const dir = mkdtempSync(join(tmpdir(), "pi-git-backend-"));
    writeFileSync(join(dir, "backends.json"), "{");
    expect(loadBackends(dir)).toEqual({});
  });
});
