import { existsSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  addSummary,
  claimSummary,
  dirs,
  type Entry,
  endSession,
  entryId,
  heartbeat,
  loadEntries,
  loadSummaries,
  lock,
  removeEntry,
  saveEntry,
  sessionAlive,
} from "./state.ts";

const fresh = () => mkdtempSync(join(tmpdir(), "pi-git-state-"));

const entry = (id: string): Entry => ({
  id,
  repo: "o/r",
  number: 1,
  url: "u",
  worktree: "/w",
  mainRoot: "/m",
  branch: "feat/x",
  base: "main",
  intent: "i",
  sessionId: "s",
  status: "watching",
  attempts: 0,
  errors: 0,
  notes: [],
  updated: "t",
});

describe("entries", () => {
  test("save, load, remove; broken files are skipped", () => {
    const dir = fresh();
    expect(loadEntries(dir)).toEqual([]);
    saveEntry(dir, entry("b"));
    saveEntry(dir, entry("a"));
    writeFileSync(join(dirs(dir).prs, "broken.json"), "{");
    writeFileSync(join(dirs(dir).prs, "notes.txt"), "x");
    expect(loadEntries(dir).map((e) => e.id)).toEqual(["a", "b"]);
    removeEntry(dir, "a");
    removeEntry(dir, "missing");
    expect(loadEntries(dir).map((e) => e.id)).toEqual(["b"]);
  });

  test("entryId", () => {
    expect(entryId("Owner/my.repo", 12)).toBe("Owner__my.repo__12");
  });
});

describe("summaries", () => {
  test("add, load, claim once", () => {
    const dir = fresh();
    const summary = addSummary(dir, {
      entryId: "e",
      repo: "o/r",
      number: 1,
      sessionId: "s",
      status: "green",
      text: "t",
      created: "2026-10-31T01:02:03.004Z",
    });
    expect(summary.id).toBe("20261031010203004-e");
    expect(loadSummaries(dir)).toEqual([summary]);
    expect(claimSummary(dir, summary.id)).toBe(true);
    expect(claimSummary(dir, summary.id)).toBe(false);
    expect(loadSummaries(dir)).toEqual([]);
    expect(existsSync(join(dirs(dir).delivered, `${summary.id}.json`))).toBe(true);
  });
});

describe("sessions", () => {
  test("heartbeat, alive, end", () => {
    const dir = fresh();
    const now = new Date("2026-10-31T00:00:00Z");
    heartbeat(dir, "s", now);
    expect(sessionAlive(dir, "s", 1000, now.getTime() + 500)).toBe(true);
    expect(sessionAlive(dir, "s", 1000, now.getTime() + 5000)).toBe(false);
    endSession(dir, "s");
    expect(sessionAlive(dir, "s", 1000, now.getTime())).toBe(false);
  });
});

describe("lock", () => {
  test("one holder; a stale lock is taken over; a vanished lock is not", () => {
    const dir = fresh();
    const release = lock(dir, "w", 1000);
    expect(release).toBeDefined();
    expect(lock(dir, "w", 1000)).toBeUndefined();
    const path = join(dirs(dir).locks, "w");
    utimesSync(path, new Date(0), new Date(0));
    const again = lock(dir, "w", 1000);
    expect(again).toBeDefined();
    again?.();
    expect(existsSync(path)).toBe(false);
    expect(lock(dir, "w", 1000, Date.now())).toBeDefined();
  });
});
