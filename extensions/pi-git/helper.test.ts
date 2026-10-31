import { describe, expect, test, vi } from "vitest";
import { defaults } from "./config.ts";
import type { Runner } from "./exec.ts";
import { askJson, HELPER_ENV, helperArgs, runHelper } from "./helper.ts";
import { stringField } from "./json.ts";

const config = { ...defaults("p", {}, "/home/u"), skill: "/skills/git", pi: "/bin/pi", helperTimeout: 10 };

describe("helperArgs", () => {
  test("answer and fix", () => {
    expect(helperArgs(config, { cwd: "/", prompt: "Do it", input: "", fix: false })).toEqual([
      "-p",
      "--no-session",
      "--model",
      "openai-codex/gpt-6-luna",
      "--thinking",
      "xhigh",
      "--skill",
      "/skills/git",
      "--tools",
      "read",
      "--no-extensions",
      "/skill:git Do it",
    ]);
    const fix = helperArgs({ ...config, skill: undefined }, { cwd: "/", prompt: "Fix", input: "", fix: true });
    expect(fix).toContain("read,bash,edit,write,grep,find,ls");
    expect(fix).not.toContain("--no-extensions");
    expect(fix.at(-1)).toBe("Fix");
  });
});

describe("runHelper", () => {
  test("passes cwd, input, env and timeout; reports failures", async () => {
    const run = vi.fn<Runner>(async () => ({ code: 0, stdout: " done \n", stderr: "" }));
    expect(await runHelper(run, config, { cwd: "/w", prompt: "p", input: "data", fix: true })).toEqual({
      ok: true,
      text: "done",
    });
    expect(run.mock.calls[0]?.[2]).toEqual({
      cwd: "/w",
      input: "data",
      env: { [HELPER_ENV]: "fix" },
      timeoutMs: 10_000,
      signal: undefined,
    });
    run.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "no auth" });
    expect(await runHelper(run, config, { cwd: "/w", prompt: "p", input: "", fix: false })).toEqual({
      ok: false,
      text: "",
      failure: "the helper failed: no auth",
    });
  });
});

describe("askJson", () => {
  const parse = (value: unknown) => {
    const a = stringField(value, "a");
    return a instanceof Error ? a : { a };
  };

  test("asks again after an unusable answer", async () => {
    const run = vi.fn<Runner>();
    run.mockResolvedValueOnce({ code: 0, stdout: "no json", stderr: "" });
    run.mockResolvedValueOnce({ code: 0, stdout: '{"a": "x"}', stderr: "" });
    expect(await askJson(run, config, { cwd: "/", prompt: "p", input: "" }, parse)).toEqual({ a: "x" });
    expect(run.mock.calls[1]?.[1].at(-1)).toContain("could not be used (no JSON object in the answer)");
  });

  test("gives up, or stops when the helper fails", async () => {
    const run = vi.fn<Runner>(async () => ({ code: 0, stdout: '{"a": ""}', stderr: "" }));
    expect(await askJson(run, config, { cwd: "/", prompt: "p", input: "" }, parse)).toEqual(
      new Error('"a" must be a non-empty string'),
    );
    expect(run).toHaveBeenCalledTimes(2);
    const failing = vi.fn<Runner>(async () => ({ code: 1, stdout: "", stderr: "x" }));
    expect(await askJson(failing, config, { cwd: "/", prompt: "p", input: "" }, parse)).toEqual(
      new Error("the helper failed: x"),
    );
  });
});
