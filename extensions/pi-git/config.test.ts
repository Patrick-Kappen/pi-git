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
      errors: [],
    });
    expect(defaults("p", { XDG_STATE_HOME: "/state" }, home).stateDir).toBe("/state/pi-git");
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
      errors: [],
    });
  });

  test("errors keep the defaults", () => {
    const config = parseConfig({ model: "", attempts: 0, delivery: "mail", other: 1 }, base, home);
    expect(config.model).toBe(base.model);
    expect(config.attempts).toBe(3);
    expect(config.errors).toEqual([
      'cfg: "model" must be a string',
      'cfg: "attempts" must be a positive number',
      'cfg: "delivery" must be one of turn, message, notify',
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
