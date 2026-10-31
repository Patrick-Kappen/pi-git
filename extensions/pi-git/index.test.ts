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

vi.mock("./start.ts", async (original) => ({
  ...(await original<typeof import("./start.ts")>()),
  findMainCheckout: vi.fn(async (_deps: unknown, repo: string) =>
    repo === "missing" ? { error: "no main checkout of missing" } : repo,
  ),
  gitStart: vi.fn(async (input: { topic: string }) => ({
    ok: true,
    summary: `Created ${input.topic}`,
    path: `/wt/${input.topic}`,
    branch: `feat/${input.topic}`,
  })),
}));

vi.mock("./pr.ts", () => ({
  gitPush: vi.fn(async () => ({ ok: true, summary: "Pushed feat/x", notes: [] })),
  gitCommit: vi.fn(async () => ({
    ok: true,
    summary: 'Committed abc "feat: x"',
    commit: { sha: "abc", subject: "feat: x" },
    notes: [],
  })),
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
const { gitCommit, gitPr, gitPush } = await import("./pr.ts");
const { gitStart } = await import("./start.ts");
const { gitCheck } = await import("./check.ts");
const state = await import("./state.ts");
const { addAttention, listAttention } = await import("./attention.ts");

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
    expect(tools.map((tool) => tool.name)).toEqual([
      "git_request",
      "git_status",
      "git_watch",
      "git_start",
      "git_push",
      "git_commit",
      "git_pr",
      "git_check",
    ]);
    const onUpdate = vi.fn();
    const result = await tools
      .find((tool) => tool.name === "git_pr")
      ?.execute("id", { intent: "x", base: "dev", draft: true }, undefined, onUpdate, ctx());
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
    const result = await tools
      .find((tool) => tool.name === "git_pr")
      ?.execute("id", { intent: "nopr", path: "/p" }, undefined, undefined, ctx());
    expect(result?.content[0]?.text).toBe("Opened PR #1");
    expect(vi.mocked(gitPr).mock.calls.at(-1)?.[0]).toEqual({ path: "/p", intent: "nopr" });
    expect(state.loadEntries(stateDir)).toEqual([]);
  });

  test("a queue that cannot be written is reported, not fatal", async () => {
    const { tools, ctx } = load({ stateDir: unwritable() });
    const result = await tools
      .find((tool) => tool.name === "git_pr")
      ?.execute("id", { intent: "x" }, undefined, undefined, ctx());
    expect(result?.content[0]?.text).toContain("The watcher could not queue the PR:");
  });

  test("a failed run is an error result", async () => {
    const { tools, ctx } = load();
    await expect(
      tools.find((tool) => tool.name === "git_pr")?.execute("id", { intent: "fail" }, undefined, undefined, ctx()),
    ).rejects.toThrow("git_pr stopped: no");
  });
});

describe("git_check", () => {
  test("runs the checks and reports progress; a red result is an error", async () => {
    const { tools, ctx } = load();
    const onUpdate = vi.fn();
    const result = await tools
      .find((tool) => tool.name === "git_check")
      ?.execute("id", { command: "npm test", fix: false }, undefined, onUpdate, ctx());
    expect(result?.content[0]?.text).toBe("Checks passed");
    expect(onUpdate).toHaveBeenCalledWith({ content: [{ type: "text", text: "- running it" }], details: undefined });
    expect(vi.mocked(gitCheck).mock.calls.at(-1)?.[0]).toEqual({ path: "/w", command: "npm test", fix: false });
    await tools.find((tool) => tool.name === "git_check")?.execute("id", { path: "/p" }, undefined, undefined, ctx());
    expect(vi.mocked(gitCheck).mock.calls.at(-1)?.[0]).toEqual({ path: "/p" });
    await expect(
      tools.find((tool) => tool.name === "git_check")?.execute("id", { command: "fail" }, undefined, undefined, ctx()),
    ).rejects.toThrow("Checks fail: x");
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
  test("own summaries go into the history once, without a turn; others of a running session stay", async () => {
    const { handlers, ctx, sendMessage, stateDir, config } = load();
    state.heartbeat(config.runtimeDir, "s2");
    state.addSummary(stateDir, summary("s1"));
    state.addSummary(stateDir, summary("s2"));
    await handlers.get("session_start")?.({}, ctx("s1"));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      { customType: "pi-git", content: "green for s1", display: true },
      { deliverAs: "nextTurn" },
    );
    expect(state.loadSummaries(stateDir).map((s) => s.sessionId)).toEqual(["s2"]);
    handlers.get("session_shutdown")?.({}, ctx());
  });

  test("only a PR that needs the agent starts a turn", async () => {
    const { handlers, ctx, sendMessage, stateDir } = load();
    state.addSummary(stateDir, { ...summary("s1"), status: "failed", text: "needs you" });
    await handlers.get("session_start")?.({}, ctx("s1"));
    expect(sendMessage).toHaveBeenCalledWith(
      { customType: "pi-git", content: "needs you", display: true },
      { triggerTurn: true, deliverAs: "followUp" },
    );
    handlers.get("session_shutdown")?.({}, ctx());
  });

  test("a gone session's summary goes to a session of the same repository", async () => {
    const { handlers, ctx, sendMessage, stateDir, config } = load({ delivery: "message" });
    state.heartbeat(config.runtimeDir, "old");
    utimesSync(join(state.dirs(config.runtimeDir).sessions, "old"), new Date(0), new Date(0));
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
    const { handlers, ctx, sendMessage, notify, stateDir, config } = load({ delivery: "notify" });
    await handlers.get("session_start")?.({}, ctx("s1"));
    state.addSummary(stateDir, summary("s1"));
    vi.advanceTimersByTime(POLL_MS);
    expect(notify).toHaveBeenCalledWith("green for s1", "info");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(state.sessionAlive(config.runtimeDir, "s1", 60_000)).toBe(true);
    await handlers.get("session_start")?.({}, ctx("s1", false));
    state.addSummary(stateDir, { ...summary("s1"), entryId: "second" });
    vi.advanceTimersByTime(POLL_MS);
    expect(notify).toHaveBeenCalledTimes(1);
    handlers.get("session_shutdown")?.({}, ctx());
    handlers.get("session_shutdown")?.({}, ctx());
    expect(state.sessionAlive(config.runtimeDir, "s1", 60_000)).toBe(false);
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
    expect(registerTool).toHaveBeenCalledTimes(8);
  });
});

describe("the lock", () => {
  const prompt = (handlers: Map<string, (event: unknown, ctx: unknown) => unknown>, ctx: unknown) => {
    const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
    handlers.get("before_agent_start")?.(event, ctx);
    return event.systemPromptOptions.sections.pi_git ?? "";
  };

  test("locked by default: git changes and the tools are blocked, reading is not", async () => {
    const { handlers, tools, ctx, setStatus } = load({ locked: true });
    await handlers.get("session_start")?.({}, ctx());
    expect(setStatus).toHaveBeenCalledWith("pi-git", "git: locked");
    expect(prompt(handlers, ctx())).toMatch(/^git: locked in o\/r\.\nBlocked for you:/);
    const call = (command: string) => handlers.get("tool_call")?.({ toolName: "bash", input: { command } }, ctx());
    expect(await call("git status && git log")).toBeUndefined();
    expect(await call("npm test && git commit -m x")).toEqual({
      block: true,
      reason:
        "pi-git: commit is locked in o/r (git commit). Only the user can allow it: /git unlock commit, or /git commit for one time.",
    });
    expect(await call("gh pr create -R a/b")).toMatchObject({
      reason: expect.stringContaining("pr is locked in a/b (gh pr create)"),
    });
    expect(await handlers.get("tool_call")?.({ toolName: "read", input: { path: "x" } }, ctx())).toBeUndefined();
    const commit = tools.find((tool) => tool.name === "git_commit");
    await expect(commit?.execute("id", { intent: "x" }, undefined, undefined, ctx())).rejects.toThrow(
      "commit is locked in o/r (git_commit)",
    );
    vi.mocked(gitPr).mockClear();
    await tools.find((tool) => tool.name === "git_pr")?.execute("id", { intent: "x" }, undefined, undefined, ctx());
    const allowed = vi.mocked(gitPr).mock.calls[0]?.[1].allowed;
    expect(["worktree", "commit", "push", "pr"].map((step) => allowed?.(step as never))).toEqual([
      false,
      false,
      false,
      false,
    ]);
    handlers.get("session_shutdown")?.({}, ctx());
  });

  test("per step: unlock commit only; the prompt, the status and git_pr follow", async () => {
    const { handlers, commands, tools, ctx, setStatus, notify } = load({ locked: true });
    await handlers.get("session_start")?.({}, ctx());
    await commands.get("git")?.handler("unlock commit", ctx());
    expect(setStatus).toHaveBeenLastCalledWith("pi-git", "git: commit unlocked");
    expect(notify.mock.lastCall?.[0]).toContain("  commit   unlocked (/git, this repository)");
    expect(prompt(handlers, ctx())).toMatch(/^git: commit unlocked in o\/r\.\nAllowed: commit\./);
    expect(
      await handlers.get("tool_call")?.({ toolName: "bash", input: { command: "git commit -m x" } }, ctx()),
    ).toBeUndefined();
    expect(
      await handlers.get("tool_call")?.({ toolName: "bash", input: { command: "git push" } }, ctx()),
    ).toMatchObject({ block: true });
    const result = await tools
      .find((tool) => tool.name === "git_commit")
      ?.execute("id", { intent: "x" }, undefined, undefined, ctx());
    expect(result?.content[0]?.text).toBe('Committed abc "feat: x"');
    vi.mocked(gitPr).mockClear();
    await tools.find((tool) => tool.name === "git_pr")?.execute("id", { intent: "x" }, undefined, undefined, ctx());
    const allowed = vi.mocked(gitPr).mock.calls[0]?.[1].allowed;
    expect(["commit", "push"].map((step) => allowed?.(step as never))).toEqual([true, false]);
    await commands.get("git")?.handler("global unlock", ctx());
    await commands.get("git")?.handler("lock", ctx());
    await commands.get("git")?.handler("reset", ctx());
    await commands.get("git")?.handler("global reset", ctx());
    await commands.get("git")?.handler("", ctx());
    expect(notify.mock.lastCall?.[0]).toMatch(/^git in o\/r:\n {2}worktree locked {3}\(default of the settings\)/);
    await commands.get("git")?.handler("maybe", ctx());
    expect(notify).toHaveBeenLastCalledWith(
      expect.stringContaining("/git unlock|lock|reset [worktree commit push pr]"),
      "warning",
    );
    expect(commands.get("git")?.getArgumentCompletions("unlock c")).toEqual([
      { value: "unlock commit", label: "unlock commit" },
    ]);
    handlers.get("session_shutdown")?.({}, ctx());
  });

  test("/git commit: the user's own action, also when commit is locked", async () => {
    const { handlers, commands, ctx, notify } = load({ locked: true });
    await handlers.get("session_start")?.({}, ctx());
    vi.mocked(gitCommit).mockClear();
    await commands.get("git")?.handler("commit fix the docs", ctx());
    expect(vi.mocked(gitCommit).mock.calls[0]?.[0]).toEqual({ path: "/w", intent: "fix the docs" });
    expect(notify).toHaveBeenLastCalledWith('Committed abc "feat: x"', "info");
    await commands.get("git")?.handler("commit", ctx());
    expect(vi.mocked(gitCommit).mock.calls[1]?.[0].intent).toContain("no intent given");
    vi.mocked(gitCommit).mockResolvedValueOnce({ ok: false, summary: "nothing to commit", notes: [] });
    await commands.get("git")?.handler("commit", ctx());
    expect(notify).toHaveBeenLastCalledWith("nothing to commit", "error");
    handlers.get("session_shutdown")?.({}, ctx());
  });

  test("git_commit failures are errors", async () => {
    const { handlers, tools, ctx } = load({ locked: false });
    await handlers.get("session_start")?.({}, ctx());
    vi.mocked(gitCommit).mockResolvedValueOnce({ ok: false, summary: "nothing to commit", notes: [] });
    await expect(
      tools
        .find((tool) => tool.name === "git_commit")
        ?.execute("id", { intent: "x", path: "/p" }, undefined, undefined, ctx()),
    ).rejects.toThrow("nothing to commit");
    expect(vi.mocked(gitCommit).mock.calls.at(-1)?.[0]).toEqual({ path: "/p", intent: "x" });
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
    expect(env.PI_GIT_REPOS).toBe("{}");
    await commands.get("git")?.handler("unlock", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("not in a repository with an origin"), "warning");
    await commands.get("git")?.handler("global lock", ctx);
    expect(notify.mock.lastCall?.[0]).toContain("  commit   locked   (/git global)");
    expect(await handlers.get("tool_call")?.({ toolName: "bash", input: { command: "git init" } }, ctx)).toMatchObject({
      reason: expect.stringContaining("commit is locked outside a repository with an origin (git init)"),
    });
    handlers.get("session_shutdown")?.({}, ctx);
  });

  test("what needs the user: blocked steps, requests, the footer, /git, unlock and clear", async () => {
    const { handlers, commands, tools, ctx, notify, setStatus, stateDir } = load({ locked: true });
    await handlers.get("session_start")?.({}, ctx());
    await handlers.get("tool_call")?.({ toolName: "bash", input: { command: "git push" } }, ctx());
    await handlers.get("tool_call")?.({ toolName: "bash", input: { command: "git push origin x" } }, ctx());
    expect(notify).toHaveBeenCalledWith(
      "The agent wanted git push in o/r, but push is locked: /git unlock push, or /git push once.",
      "warning",
    );
    expect(notify.mock.calls.filter(([text]) => String(text).startsWith("The agent wanted git push")).length).toBe(1);
    expect(setStatus).toHaveBeenLastCalledWith("pi-git", "git: locked ● 1");
    const request = tools.find((tool) => tool.name === "git_request");
    const answer = await request?.execute(
      "id",
      { reason: "The fix must be committed.", step: "commit" },
      undefined,
      undefined,
      ctx(),
    );
    expect(answer?.content[0]?.text).toContain("The user is notified");
    await request?.execute("id", { reason: "Which API version?" }, undefined, undefined, ctx());
    expect(
      listAttention(stateDir)
        .map((item) => item.text)
        .sort(),
    ).toEqual([
      "The agent wanted git push in o/r, but push is locked: /git unlock push, or /git push once.",
      "o/r: The fix must be committed. /git unlock commit, or /git commit once.",
      "o/r: Which API version?",
    ]);
    await commands.get("git")?.handler("", ctx());
    expect(notify.mock.lastCall?.[0]).toContain("needs you:\n- The agent wanted git push in o/r");
    await commands.get("git")?.handler("unlock push", ctx());
    expect(
      listAttention(stateDir)
        .map((item) => item.step ?? "none")
        .sort(),
    ).toEqual(["commit", "none"]);
    await commands.get("git")?.handler("commit", ctx());
    expect(listAttention(stateDir).map((item) => item.text)).toEqual(["o/r: Which API version?"]);
    addAttention(stateDir, { kind: "watcher", repo: "o/r", text: "PR #1 needs you" }, "o__r__1");
    await commands.get("git")?.handler("lock", ctx());
    await commands.get("git")?.handler("unlock", ctx());
    expect(listAttention(stateDir)).toHaveLength(2);
    await commands.get("git")?.handler("clear", ctx());
    expect(notify).toHaveBeenLastCalledWith("pi-git: forgot 2 item(s) that needed you", "info");
    handlers.get("session_shutdown")?.({}, ctx());
  });

  test("git_commit and git_pr that hit a lock need the user", async () => {
    const { handlers, commands, tools, ctx, stateDir } = load({ locked: true });
    await handlers.get("session_start")?.({}, ctx());
    await expect(
      tools.find((tool) => tool.name === "git_commit")?.execute("id", { intent: "x" }, undefined, undefined, ctx()),
    ).rejects.toThrow();
    expect(listAttention(stateDir).map((item) => item.step)).toEqual(["commit"]);
    await commands.get("git")?.handler("global unlock", ctx());
    expect(listAttention(stateDir)).toEqual([]);
    vi.mocked(gitPr).mockResolvedValueOnce({
      ok: true,
      summary: "Committed; stopped before push",
      notes: [],
      stopped: "push",
    });
    await tools.find((tool) => tool.name === "git_pr")?.execute("id", { intent: "x" }, undefined, undefined, ctx());
    expect(listAttention(stateDir).map((item) => item.text)).toEqual([
      "The agent wanted git_pr in o/r, but push is locked: /git unlock push, or /git push once.",
    ]);
    handlers.get("session_shutdown")?.({}, ctx());
  });

  test("git_request outside a repository, and a state directory that cannot be written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-git-index-"));
    const file = join(dir, "file");
    writeFileSync(file, "");
    writeFileSync(join(dir, "pi-git.json"), JSON.stringify({ stateDir: join(file, "state") }));
    const tools: Tool[] = [];
    const failing: Runner = async () => ({ code: 128, stdout: "", stderr: "" });
    createPiGit(
      {
        on: () => {},
        registerTool: (tool: never) => tools.push(tool),
        registerCommand: () => {},
        sendMessage: vi.fn(),
      } as never,
      { env: { PI_GIT_CONFIG: join(dir, "pi-git.json") }, home: dir, run: failing },
    );
    const ctx = {
      cwd: "/",
      hasUI: false,
      ui: { notify: vi.fn(), setStatus: vi.fn() },
      sessionManager: { getSessionId: () => "s" },
    };
    const answer = await tools
      .find((tool) => tool.name === "git_request")
      ?.execute("id", { reason: "Decide." }, undefined, undefined, ctx);
    expect(answer?.content[0]?.text).toContain("The user is notified");
  });

  test("git_worktree and git_push follow their steps", async () => {
    const { handlers, commands, tools, ctx, stateDir } = load({ locked: true });
    await handlers.get("session_start")?.({}, ctx());
    const tool = (name: string) => tools.find((item) => item.name === name);
    await expect(tool("git_start")?.execute("id", { topic: "x" }, undefined, undefined, ctx())).rejects.toThrow(
      "worktree is locked in o/r (git_start)",
    );
    await expect(tool("git_push")?.execute("id", {}, undefined, undefined, ctx())).rejects.toThrow(
      "push is locked in o/r (git_push)",
    );
    expect(
      listAttention(stateDir)
        .map((item) => item.step)
        .sort(),
    ).toEqual(["push", "worktree"]);
    await commands.get("git")?.handler("unlock worktree push", ctx());
    const created = await tool("git_start")?.execute(
      "id",
      { topic: "x", type: "fix", base: "dev", repo: "/p" },
      undefined,
      undefined,
      ctx(),
    );
    expect(created?.content[0]?.text).toBe("Created x");
    expect(vi.mocked(gitStart).mock.calls.at(-1)?.[0]).toEqual({ repo: "/p", topic: "x", type: "fix", base: "dev" });
    await tool("git_start")?.execute("id", { topic: "y" }, undefined, undefined, ctx());
    expect(vi.mocked(gitStart).mock.calls.at(-1)?.[0]).toEqual({ repo: "/w", topic: "y" });
    const pushed = await tool("git_push")?.execute("id", { intent: "Ship it." }, undefined, undefined, ctx());
    expect(pushed?.content[0]?.text).toBe("Pushed feat/x");
    const deps = vi.mocked(gitPush).mock.calls.at(-1)?.[1];
    expect(vi.mocked(gitPush).mock.calls.at(-1)?.[0]).toEqual({ path: "/w", intent: "Ship it." });
    expect([deps?.allowed?.("push"), deps?.allowed?.("commit")]).toEqual([true, false]);
    await tool("git_push")?.execute("id", {}, undefined, undefined, ctx());
    expect(vi.mocked(gitPush).mock.calls.at(-1)?.[0].intent).toBe("Fix the failing pre-push checks.");
    vi.mocked(gitStart).mockResolvedValueOnce({ ok: false, summary: "exists" });
    await expect(tool("git_start")?.execute("id", { topic: "z" }, undefined, undefined, ctx())).rejects.toThrow(
      "exists",
    );
    await expect(
      tool("git_start")?.execute("id", { topic: "z", repo: "missing" }, undefined, undefined, ctx()),
    ).rejects.toThrow("no main checkout of missing");
    vi.mocked(gitPush).mockResolvedValueOnce({ ok: false, summary: "The push failed", notes: [] });
    await expect(tool("git_push")?.execute("id", {}, undefined, undefined, ctx())).rejects.toThrow("The push failed");
    handlers.get("session_shutdown")?.({}, ctx());
  });

  test("/git worktree, /git push and /git pr: once, also when locked", async () => {
    const { handlers, commands, ctx, notify, stateDir } = load({ locked: true });
    await handlers.get("session_start")?.({}, ctx());
    await commands.get("git")?.handler("worktree login-timeout fix", ctx());
    expect(vi.mocked(gitStart).mock.calls.at(-1)?.[0]).toEqual({ repo: "/w", topic: "login-timeout", type: "fix" });
    expect(notify).toHaveBeenLastCalledWith("Created login-timeout", "info");
    await commands.get("git")?.handler("worktree", ctx());
    expect(vi.mocked(gitStart).mock.calls.at(-1)?.[0]).toEqual({ repo: "/w", topic: "" });
    await commands.get("git")?.handler("push", ctx());
    expect(vi.mocked(gitPush).mock.calls.at(-1)?.[1].allowed).toBeUndefined();
    vi.mocked(gitPr).mockClear();
    await commands.get("git")?.handler("pr ship the fix", ctx());
    expect(vi.mocked(gitPr).mock.calls[0]?.[0]).toEqual({ path: "/w", intent: "ship the fix" });
    expect(state.loadEntries(stateDir).map((entry) => entry.id)).toEqual(["o__r__1"]);
    vi.mocked(gitPr).mockResolvedValueOnce({ ok: false, summary: "git_pr stopped: x", notes: [] });
    await commands.get("git")?.handler("pr", ctx());
    expect(notify).toHaveBeenLastCalledWith("git_pr stopped: x", "error");
    handlers.get("session_shutdown")?.({}, ctx());
  });

  test("git_request replaces the blocked item of its step, and does not repeat the commands", async () => {
    const { handlers, tools, ctx, stateDir } = load({ locked: true });
    await handlers.get("session_start")?.({}, ctx());
    await handlers.get("tool_call")?.({ toolName: "bash", input: { command: "git push" } }, ctx());
    const request = tools.find((tool) => tool.name === "git_request");
    await request?.execute(
      "id",
      { reason: "Committed; push is locked, run /git push once.", step: "push" },
      undefined,
      undefined,
      ctx(),
    );
    expect(listAttention(stateDir).map((item) => [item.kind, item.text])).toEqual([
      ["request", "o/r: Committed; push is locked, run /git push once."],
    ]);
    handlers.get("session_shutdown")?.({}, ctx());
  });
});
