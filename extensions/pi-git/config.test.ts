import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { configPath, defaults, loadConfig, parseConfig } from "./config.ts";

const home = "/home/u";

describe("configPath", () => {
  test("default, agent dir and override", () => {
    expect(configPath({}, home)).toBe("/home/u/.pi/agent/pi-git.json");
    expect(configPath({ PI_CODING_AGENT_DIR: "~/a" }, home)).toBe("/home/u/a/pi-git.json");
    expect(configPath({ PI_GIT_CONFIG: "~/g.json" }, home)).toBe("/home/u/g.json");
  });
});

describe("defaults", () => {
  test("model, paths and delivery", () => {
    expect(defaults("p", {}, home)).toEqual({
      path: "p",
      model: "openai-codex/gpt-6-luna",
      thinking: "xhigh",
      skill: undefined,
      pi: "pi",
      attempts: 3,
      checkTimeout: 1800,
      helperTimeout: 900,
      worktrees: "/home/u/.worktrees",
      stateDir: "/home/u/.local/state/pi-git",
      delivery: "turn",
      locked: true,
      repos: {},
      runtimeDir: "/home/u/.local/state/pi-git/run",
      shipNixos: undefined,
      shipHost: expect.any(String),
      shipModel: "openai-codex/gpt-6-luna",
      shipThinking: "medium",
      errors: [],
    });
    expect(defaults("p", { XDG_STATE_HOME: "/state" }, home).stateDir).toBe("/state/pi-git");
    expect(defaults("p", { XDG_RUNTIME_DIR: "/run/user/1" }, home).runtimeDir).toBe("/run/user/1/pi-git");
  });
});

describe("parseConfig", () => {
  const base = defaults("cfg", {}, home);

  test("settings", () => {
    const config = parseConfig(
      {
        model: "m",
        thinking: "low",
        skill: "~/skills/git",
        pi: "/bin/pi",
        attempts: 5,
        checkTimeout: 60,
        helperTimeout: 30,
        worktrees: "/w",
        stateDir: "~/s",
        delivery: "notify",
        locked: false,
      },
      base,
      home,
    );
    expect(config).toMatchObject({
      model: "m",
      thinking: "low",
      skill: "/home/u/skills/git",
      pi: "/bin/pi",
      attempts: 5,
      checkTimeout: 60,
      helperTimeout: 30,
      worktrees: "/w",
      stateDir: "/home/u/s",
      delivery: "notify",
      locked: false,
      errors: [],
    });
  });

  test("repos and runtimeDir", () => {
    const config = parseConfig(
      { repos: { "o/*": "locked", "o/r": { push: "unlocked" } }, runtimeDir: "~/run" },
      base,
      home,
    );
    expect(config).toMatchObject({
      repos: {
        "o/*": { worktree: "locked", commit: "locked", push: "locked", pr: "locked" },
        "o/r": { push: "unlocked" },
      },
      runtimeDir: "/home/u/run",
      errors: [],
    });
    expect(parseConfig({ repos: [] }, base, home).errors).toEqual(['cfg: "repos" must be an object of patterns']);
    expect(parseConfig({ repos: { "o/r": "maybe" } }, base, home).errors).toEqual([
      'cfg: "repos": every pattern needs "locked", "unlocked" or steps',
    ]);
  });

  test("errors keep the defaults", () => {
    const config = parseConfig({ model: "", attempts: 0, delivery: "mail", locked: "no", other: 1 }, base, home);
    expect(config.model).toBe(base.model);
    expect(config.attempts).toBe(3);
    expect(config.errors).toEqual([
      'cfg: "model" must be a string',
      'cfg: "attempts" must be a positive number',
      'cfg: "delivery" must be one of turn, message, notify',
      'cfg: "locked" must be true or false',
      'cfg: unknown key "other"',
    ]);
    expect(parseConfig([], base, home).errors).toEqual(["cfg: expected a JSON object"]);
  });
});

describe("loadConfig", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-git-config-"));

  test("missing, valid, invalid JSON, unreadable", () => {
    expect(loadConfig({ PI_GIT_CONFIG: join(dir, "missing.json") }, home).errors).toEqual([]);
    writeFileSync(join(dir, "ok.json"), JSON.stringify({ attempts: 1 }));
    expect(loadConfig({ PI_GIT_CONFIG: join(dir, "ok.json") }, home).attempts).toBe(1);
    writeFileSync(join(dir, "bad.json"), "{");
    expect(loadConfig({ PI_GIT_CONFIG: join(dir, "bad.json") }, home).errors[0]).toMatch(/invalid JSON/);
    expect(loadConfig({ PI_GIT_CONFIG: dir }, home).errors[0]).toMatch(/EISDIR/);
  });
});
