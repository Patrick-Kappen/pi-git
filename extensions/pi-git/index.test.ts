import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import { defaults } from "./config.ts";
import type { Runner } from "./exec.ts";
import type { PrResult } from "./pr.ts";
import type { Entry } from "./state.ts";

vi.mock("./check.ts", () => ({
  gitCheck: vi.fn(async (input: { command?: string }, deps: { progress: (s: string) => void }) => {
    deps.progress("running it");
    return input.command === "fail"
      ? { ok: false, summary: "Checks fail: x", notes: [] }
      : { ok: true, summary: "Checks passed", command: input.command, notes: [] };
  }),
}));

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

const { createPiGit, default: piGit, enqueue, guardHelper, lockPrompt, POLL_MS, takes } = await import("./index.ts");
const { gitPr } = await import("./pr.ts");
const { gitCheck } = await import("./check.ts");
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
  writeFileSync(join(dir, "pi-git.json"), JSON.stringify({ stateDir, locked: false, ...settings }));
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const tools: Tool[] = [];
  const sendMessage = vi.fn();
  const commands = new Map<
    string,
    { handler: (args: string, ctx: unknown) => Promise<void>; getArgumentCompletions: (prefix: string) => unknown }
  >();
  const pi = {
    on: (name: string, handler: never) => handlers.set(name, handler),
    registerTool: (tool: never) => tools.push(tool),
    registerCommand: (name: string, command: never) => commands.set(name, command),
    sendMessage,
  };
  createPiGit(pi as never, { env: { PI_GIT_CONFIG: join(dir, "pi-git.json"), ...env }, home: dir, run: origin });
  const notify = vi.fn();
  const setStatus = vi.fn();
  const ctx = (sessionId = "s1", hasUI = true) => ({
    cwd: "/w",
    hasUI,
    ui: { notify, setStatus },
    sessionManager: { getSessionId: () => sessionId },
  });
  const config = { ...defaults("p", {}, dir), stateDir };
  return { handlers, tools, commands, sendMessage, notify, setStatus, ctx, stateDir, config, dir };
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
    expect(tools.map((tool) => tool.name)).toEqual(["git_pr", "git_check"]);
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

describe("git_check", () => {
  test("runs the checks and reports progress; a red result is an error", async () => {
    const { tools, ctx } = load();
    const onUpdate = vi.fn();
    const result = await tools[1]?.execute("id", { command: "npm test", fix: false }, undefined, onUpdate, ctx());
    expect(result?.content[0]?.text).toBe("Checks passed");
    expect(onUpdate).toHaveBeenCalledWith({ content: [{ type: "text", text: "- running it" }], details: undefined });
    expect(vi.mocked(gitCheck).mock.calls.at(-1)?.[0]).toEqual({ path: "/w", command: "npm test", fix: false });
    await tools[1]?.execute("id", { path: "/p" }, undefined, undefined, ctx());
    expect(vi.mocked(gitCheck).mock.calls.at(-1)?.[0]).toEqual({ path: "/p" });
    await expect(tools[1]?.execute("id", { command: "fail" }, undefined, undefined, ctx())).rejects.toThrow(
      "Checks fail: x",
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
      registerCommand: () => {},
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
        registerCommand: vi.fn(),
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
    piGit({ on: vi.fn(), registerTool, registerCommand: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI);
    if (saved !== undefined) process.env.PI_GIT_HELPER = saved;
    expect(registerTool).toHaveBeenCalledTimes(2);
  });
});

describe("the lock", () => {
  test("locked by default: git changes and git_pr are blocked, reading is not", async () => {
    const { handlers, tools, ctx, setStatus } = load({ locked: true });
    await handlers.get("session_start")?.({}, ctx());
    expect(setStatus).toHaveBeenCalledWith("pi-git", "git: locked");
    const call = (command: string) => handlers.get("tool_call")?.({ toolName: "bash", input: { command } }, ctx());
    expect(await call("git status && git log")).toBeUndefined();
    expect(await call("npm test && git commit -m x")).toEqual({
      block: true,
      reason: "pi-git: git changes are locked in o/r (git commit). Only the user can unlock them, with /git unlock.",
    });
    expect(await call("gh pr create -R a/b")).toMatchObject({
      reason: expect.stringContaining("locked in a/b (gh pr create)"),
    });
    expect(await handlers.get("tool_call")?.({ toolName: "read", input: { path: "x" } }, ctx())).toBeUndefined();
    await expect(tools[0]?.execute("id", { intent: "x" }, undefined, undefined, ctx())).rejects.toThrow(
      "locked in o/r (git_pr)",
    );
    handlers.get("session_shutdown")?.({}, ctx());
  });

  test("/git unlock remembers the repository; global and reset", async () => {
    const { handlers, commands, ctx, notify, setStatus, stateDir } = load({ locked: true });
    await handlers.get("session_start")?.({}, ctx());
    const git = commands.get("git");
    await git?.handler("unlock", ctx());
    expect(setStatus).toHaveBeenLastCalledWith("pi-git", "git: unlocked");
    expect(notify.mock.lastCall?.[0]).toContain("git changes in o/r: unlocked (override of this repository)");
    expect(
      await handlers.get("tool_call")?.({ toolName: "bash", input: { command: "git commit -m x" } }, ctx()),
    ).toBeUndefined();
    expect(
      await handlers.get("tool_call")?.({ toolName: "bash", input: { command: "gh pr merge 1 -R x/y" } }, ctx()),
    ).toMatchObject({ block: true });
    await git?.handler("global unlock", ctx());
    await git?.handler("lock", ctx());
    expect(notify.mock.lastCall?.[0]).toContain("global: unlocked\noverrides:\n  o/r: locked");
    await git?.handler("reset", ctx());
    await git?.handler("global reset", ctx());
    await git?.handler("", ctx());
    expect(notify.mock.lastCall?.[0]).toContain(
      "git changes in o/r: locked (default of the settings)\nglobal: not set, so the default: locked",
    );
    await git?.handler("maybe", ctx());
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("/git [unlock|lock|reset]"), "warning");
    expect(git?.getArgumentCompletions("glo")).toEqual([
      { value: "global unlock", label: "global unlock" },
      { value: "global lock", label: "global lock" },
      { value: "global reset", label: "global reset" },
    ]);
    expect(stateDir).toBeDefined();
    handlers.get("session_shutdown")?.({}, ctx());
  });

  test("/git outside a repository; the hooks get the switch file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-git-index-"));
    const env: NodeJS.ProcessEnv = { PI_GIT_CONFIG: join(dir, "pi-git.json") };
    writeFileSync(join(dir, "pi-git.json"), JSON.stringify({ stateDir: join(dir, "state"), locked: false }));
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const failing: Runner = async () => ({ code: 128, stdout: "", stderr: "" });
    createPiGit(
      {
        on: (n: string, h: never) => handlers.set(n, h),
        registerTool: () => {},
        registerCommand: (n: string, c: never) => commands.set(n, c),
        sendMessage: vi.fn(),
      } as never,
      { env, home: dir, run: failing },
    );
    const notify = vi.fn();
    const ctx = {
      cwd: "/",
      hasUI: false,
      ui: { notify, setStatus: vi.fn() },
      sessionManager: { getSessionId: () => "s" },
    };
    await handlers.get("session_start")?.({}, ctx);
    expect(env.PI_GIT_SWITCH).toBe(join(dir, "state", "switch.json"));
    expect(env.PI_GIT_DEFAULT).toBe("unlocked");
    await commands.get("git")?.handler("unlock", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("not in a repository with an origin"), "warning");
    await commands.get("git")?.handler("global lock", ctx);
    expect(notify.mock.lastCall?.[0]).toContain("git changes here: locked (global setting)");
    expect(await handlers.get("tool_call")?.({ toolName: "bash", input: { command: "git init" } }, ctx)).toMatchObject({
      reason: expect.stringContaining("locked outside a repository with an origin (git init)"),
    });
    handlers.get("session_shutdown")?.({}, ctx);
  });

  test("the agent is told the state before every prompt", async () => {
    const { handlers, commands, ctx } = load({ locked: true });
    await handlers.get("session_start")?.({}, ctx());
    const prompt = () => {
      const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
      handlers.get("before_agent_start")?.(event, ctx());
      return event.systemPromptOptions.sections.pi_git ?? "";
    };
    expect(prompt()).toMatch(/^git: locked in o\/r\. Git changes are blocked for you/);
    expect(prompt()).toContain("ask the\nuser to run /git unlock; only the user can unlock.");
    await commands.get("git")?.handler("unlock", ctx());
    expect(prompt()).toBe(
      "git: unlocked in o/r. You may change the repository; use git_pr to commit, push and open or update PRs.\nOther repositories can be locked; a blocked command says so.",
    );
    handlers.get("session_shutdown")?.({}, ctx());
  });
});

describe("lockPrompt", () => {
  test("outside a repository", () => {
    expect(lockPrompt("locked", undefined)).toMatch(/^git: locked here \(not in a repository with an origin\)\./);
    expect(lockPrompt("unlocked", undefined)).toMatch(/^git: unlocked here \(not in a repository with an origin\)\./);
  });
});
