import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import { defaults } from "./config.ts";
import type { Runner } from "./exec.ts";
import type { PrResult } from "./pr.ts";
import type { Entry } from "./state.ts";

vi.mock("./pr.ts", () => ({
  gitPr: vi.fn(async (input: { intent: string }, deps: { progress: (s: string) => void }) => {
    deps.progress("step one");
    if (input.intent === "fail") return { ok: false, summary: "git_pr stopped: no", notes: [] };
    const result: PrResult = {
      ok: true,
      summary: "Opened PR #1",
      notes: [],
      base: "main",
      pr: { number: 1, url: "https://github.com/o/r/pull/1", created: true },
      worktree: { root: "/w", branch: "feat/x", defaultBranch: "main", repo: "r", slug: "o/r", mainRoot: "/m" },
    };
    return input.intent === "nopr" ? { ...result, pr: undefined } : result;
  }),
}));

const { createPiGit, default: piGit, enqueue, guardHelper, POLL_MS, takes } = await import("./index.ts");
const { gitPr } = await import("./pr.ts");
const state = await import("./state.ts");

type Tool = { name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> };

const origin: Runner = async () => ({ code: 0, stdout: "git@github.com:o/r.git\n", stderr: "" });

/** A state directory below a regular file: every write fails. */
function unwritable(): string {
  const file = join(mkdtempSync(join(tmpdir(), "pi-git-index-")), "file");
  writeFileSync(file, "");
  return join(file, "state");
}

function load(settings: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-git-index-"));
  const stateDir = join(dir, "state");
  writeFileSync(join(dir, "pi-git.json"), JSON.stringify({ stateDir, ...settings }));
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const tools: Tool[] = [];
  const sendMessage = vi.fn();
  const pi = {
    on: (name: string, handler: never) => handlers.set(name, handler),
    registerTool: (tool: never) => tools.push(tool),
    sendMessage,
  };
  createPiGit(pi as never, { env: { PI_GIT_CONFIG: join(dir, "pi-git.json"), ...env }, home: dir, run: origin });
  const notify = vi.fn();
  const ctx = (sessionId = "s1", hasUI = true) => ({
    cwd: "/w",
    hasUI,
    ui: { notify },
    sessionManager: { getSessionId: () => sessionId },
  });
  const config = { ...defaults("p", {}, dir), stateDir };
  return { handlers, tools, sendMessage, notify, ctx, stateDir, config };
}

const summary = (sessionId: string, repo = "o/r") => ({
  entryId: `e-${sessionId}-${repo.replace("/", "-")}`,
  repo,
  number: 1,
  sessionId,
  status: "green" as const,
  text: `green for ${sessionId}`,
  created: new Date().toISOString(),
});

afterEach(() => {
  vi.useRealTimers();
});

describe("git_pr", () => {
  test("runs the flow, reports progress, and queues the PR", async () => {
    const { tools, ctx, stateDir } = load();
    expect(tools.map((tool) => tool.name)).toEqual(["git_pr"]);
    const onUpdate = vi.fn();
    const result = await tools[0]?.execute("id", { intent: "x", base: "dev", draft: true }, undefined, onUpdate, ctx());
    expect(result?.content[0]?.text).toBe(
      "Opened PR #1\nThe watcher follows CI and conflicts, and reports back when the PR is green, merged or needs you.",
    );
    expect(onUpdate).toHaveBeenCalledWith({ content: [{ type: "text", text: "- step one" }], details: undefined });
    expect(vi.mocked(gitPr).mock.calls.at(-1)?.[0]).toEqual({ path: "/w", intent: "x", base: "dev", draft: true });
    expect(state.loadEntries(stateDir)).toEqual([
      expect.objectContaining({
        id: "o__r__1",
        repo: "o/r",
        worktree: "/w",
        mainRoot: "/m",
        branch: "feat/x",
        base: "main",
        sessionId: "s1",
        status: "watching",
      }),
    ]);
  });

  test("without a PR nothing is queued; a path is passed on", async () => {
    const { tools, ctx, stateDir } = load();
    const result = await tools[0]?.execute("id", { intent: "nopr", path: "/p" }, undefined, undefined, ctx());
    expect(result?.content[0]?.text).toBe("Opened PR #1");
    expect(vi.mocked(gitPr).mock.calls.at(-1)?.[0]).toEqual({ path: "/p", intent: "nopr" });
    expect(state.loadEntries(stateDir)).toEqual([]);
  });

  test("a queue that cannot be written is reported, not fatal", async () => {
    const { tools, ctx } = load({ stateDir: unwritable() });
    const result = await tools[0]?.execute("id", { intent: "x" }, undefined, undefined, ctx());
    expect(result?.content[0]?.text).toContain("The watcher could not queue the PR:");
  });

  test("a failed run is an error result", async () => {
    const { tools, ctx } = load();
    await expect(tools[0]?.execute("id", { intent: "fail" }, undefined, undefined, ctx())).rejects.toThrow(
      "git_pr stopped: no",
    );
  });
});

describe("enqueue", () => {
  test("a queued PR keeps its fixes count and notes", () => {
    const { config } = load();
    const result = {
      ok: true,
      summary: "",
      notes: [],
      pr: { number: 1, url: "u", created: false },
      worktree: { root: "/w", branch: "b", defaultBranch: "main", repo: "r", slug: "o/r", mainRoot: "/m" },
    };
    const first = enqueue(config, result, "i", "s");
    state.saveEntry(config.stateDir, { ...(first as Entry), attempts: 2, notes: ["n"], status: "green" });
    expect(enqueue(config, result, "i2", "s2")).toMatchObject({
      attempts: 2,
      notes: ["n"],
      status: "watching",
      intent: "i2",
      sessionId: "s2",
      base: "main",
    });
  });
});

describe("summaries", () => {
  test("own summaries start a turn; others of a running session stay", async () => {
    const { handlers, ctx, sendMessage, stateDir } = load();
    state.heartbeat(stateDir, "s2");
    state.addSummary(stateDir, summary("s1"));
    state.addSummary(stateDir, summary("s2"));
    await handlers.get("session_start")?.({}, ctx("s1"));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      { customType: "pi-git", content: "green for s1", display: true },
      { triggerTurn: true, deliverAs: "followUp" },
    );
    expect(state.loadSummaries(stateDir).map((s) => s.sessionId)).toEqual(["s2"]);
    handlers.get("session_shutdown")?.({}, ctx());
  });

  test("a gone session's summary goes to a session of the same repository", async () => {
    const { handlers, ctx, sendMessage, stateDir } = load({ delivery: "message" });
    state.heartbeat(stateDir, "old");
    utimesSync(join(state.dirs(stateDir).sessions, "old"), new Date(0), new Date(0));
    state.addSummary(stateDir, summary("old"));
    state.addSummary(stateDir, summary("gone", "other/repo"));
    await handlers.get("session_start")?.({}, ctx("s1"));
    expect(sendMessage).toHaveBeenCalledWith(
      { customType: "pi-git", content: "green for old", display: true },
      { deliverAs: "nextTurn" },
    );
    expect(state.loadSummaries(stateDir).map((s) => s.repo)).toEqual(["other/repo"]);
    handlers.get("session_shutdown")?.({}, ctx());
  });

  test("notify delivery, the poll timer, and shutdown", async () => {
    vi.useFakeTimers();
    const { handlers, ctx, sendMessage, notify, stateDir } = load({ delivery: "notify" });
    await handlers.get("session_start")?.({}, ctx("s1"));
    state.addSummary(stateDir, summary("s1"));
    vi.advanceTimersByTime(POLL_MS);
    expect(notify).toHaveBeenCalledWith("green for s1", "info");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(state.sessionAlive(stateDir, "s1", 60_000)).toBe(true);
    await handlers.get("session_start")?.({}, ctx("s1", false));
    state.addSummary(stateDir, { ...summary("s1"), entryId: "second" });
    vi.advanceTimersByTime(POLL_MS);
    expect(notify).toHaveBeenCalledTimes(1);
    handlers.get("session_shutdown")?.({}, ctx());
    handlers.get("session_shutdown")?.({}, ctx());
    expect(state.sessionAlive(stateDir, "s1", 60_000)).toBe(false);
  });

  test("a state directory that cannot be written does not break the session", async () => {
    const { handlers, ctx } = load({ stateDir: unwritable() });
    await expect(handlers.get("session_start")?.({}, ctx())).resolves.toBeUndefined();
    handlers.get("session_shutdown")?.({}, ctx());
  });

  test("outside a repository, only own summaries arrive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-git-index-"));
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const sendMessage = vi.fn();
    const pi = {
      on: (name: string, handler: never) => handlers.set(name, handler),
      registerTool: () => {},
      sendMessage,
    };
    const failing: Runner = async () => ({ code: 128, stdout: "", stderr: "not a repo" });
    writeFileSync(join(dir, "pi-git.json"), JSON.stringify({ stateDir: join(dir, "state") }));
    createPiGit(pi as never, { env: { PI_GIT_CONFIG: join(dir, "pi-git.json") }, home: dir, run: failing });
    state.addSummary(join(dir, "state"), summary("gone"));
    await handlers.get("session_start")?.(
      {},
      { cwd: "/", hasUI: false, ui: {}, sessionManager: { getSessionId: () => "s9" } },
    );
    expect(sendMessage).not.toHaveBeenCalled();
    handlers.get("session_shutdown")?.({}, {});
  });

  test("takes", () => {
    const { config } = load();
    expect(takes({ ...summary("a"), id: "x" }, "a", undefined, config)).toBe(true);
    expect(takes({ ...summary("b"), id: "x" }, "a", "O/R", config)).toBe(true);
    expect(takes({ ...summary("b"), id: "x" }, "a", undefined, config)).toBe(false);
  });

  test("config errors are reported when the session starts", async () => {
    const { handlers, ctx, notify } = load({ attempts: 0 });
    await handlers.get("session_start")?.({}, ctx());
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('"attempts" must be a positive number'), "warning");
    handlers.get("session_shutdown")?.({}, ctx());
  });
});

describe("helper process", () => {
  test("registers only the guard", () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const tools: unknown[] = [];
    createPiGit(
      {
        on: (name: string, handler: never) => handlers.set(name, handler),
        registerTool: (tool: never) => tools.push(tool),
        sendMessage: vi.fn(),
      } as never,
      {
        env: { PI_GIT_HELPER: "fix" },
      },
    );
    expect(tools).toEqual([]);
    expect([...handlers.keys()]).toEqual(["tool_call"]);
    expect(handlers.get("tool_call")?.({ toolName: "bash", input: { command: "git push" } })).toMatchObject({
      block: true,
    });
  });

  test("guardHelper", () => {
    expect(guardHelper({ toolName: "bash", input: { command: "git status" } } as never)).toBeUndefined();
    expect(guardHelper({ toolName: "read", input: { path: "x" } } as never)).toBeUndefined();
    expect(guardHelper({ toolName: "bash", input: {} } as never)).toBeUndefined();
    expect(guardHelper({ toolName: "bash", input: { command: "gh pr create" } } as never)?.reason).toContain(
      "does not run gh",
    );
  });
});

describe("default export", () => {
  test("registers with the real environment", () => {
    const registerTool = vi.fn();
    const saved = process.env.PI_GIT_HELPER;
    delete process.env.PI_GIT_HELPER;
    piGit({ on: vi.fn(), registerTool, sendMessage: vi.fn() } as unknown as ExtensionAPI);
    if (saved !== undefined) process.env.PI_GIT_HELPER = saved;
    expect(registerTool).toHaveBeenCalledTimes(1);
  });
});
