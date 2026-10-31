import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";

vi.mock("./pr.ts", () => ({
  gitPr: vi.fn(async (input: { intent: string }, deps: { progress: (s: string) => void }) => {
    deps.progress("step one");
    return input.intent === "fail"
      ? { ok: false, summary: "git_pr stopped: no", notes: [] }
      : { ok: true, summary: "Opened PR #1", pr: { number: 1, url: "u", created: true }, notes: [] };
  }),
}));

const { createPiGit, default: piGit, guardHelper } = await import("./index.ts");
const { gitPr } = await import("./pr.ts");

type Tool = { name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> };

function load(env: NodeJS.ProcessEnv = { PI_GIT_CONFIG: "/nonexistent/pi-git.json" }) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const tools: Tool[] = [];
  createPiGit(
    {
      on: (name: string, handler: never) => handlers.set(name, handler),
      registerTool: (tool: never) => tools.push(tool),
    } as never,
    { env, home: "/home/u" },
  );
  return { handlers, tools };
}

describe("main agent", () => {
  test("registers git_pr; execute runs the flow and reports progress", async () => {
    const { tools } = load();
    expect(tools.map((tool) => tool.name)).toEqual(["git_pr"]);
    const onUpdate = vi.fn();
    const result = await tools[0]?.execute("id", { intent: "x", base: "dev", draft: true }, undefined, onUpdate, {
      cwd: "/w",
    });
    expect(result?.content[0]?.text).toBe("Opened PR #1");
    expect(onUpdate).toHaveBeenCalledWith({ content: [{ type: "text", text: "- step one" }], details: undefined });
    expect(vi.mocked(gitPr).mock.calls[0]?.[0]).toEqual({ path: "/w", intent: "x", base: "dev", draft: true });
    await tools[0]?.execute("id", { intent: "x", path: "/p" }, undefined, undefined, { cwd: "/w" });
    expect(vi.mocked(gitPr).mock.calls[1]?.[0]).toEqual({ path: "/p", intent: "x" });
  });

  test("a failed run is an error result", async () => {
    const { tools } = load();
    await expect(tools[0]?.execute("id", { intent: "fail" }, undefined, undefined, { cwd: "/w" })).rejects.toThrow(
      "git_pr stopped: no",
    );
  });

  test("config errors are reported when the session starts", () => {
    const { handlers } = load({ PI_GIT_CONFIG: "/" });
    const notify = vi.fn();
    handlers.get("session_start")?.({}, { hasUI: true, ui: { notify } });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("pi-git:"), "warning");
    handlers.get("session_start")?.({}, { hasUI: false, ui: { notify } });
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe("helper process", () => {
  test("registers only the guard", () => {
    const { handlers, tools } = load({ PI_GIT_HELPER: "fix" });
    expect(tools).toEqual([]);
    expect([...handlers.keys()]).toEqual(["tool_call"]);
    expect(handlers.get("tool_call")?.({ toolName: "bash", input: { command: "git push" } }, {})).toMatchObject({
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
    const on = vi.fn();
    const saved = process.env.PI_GIT_HELPER;
    delete process.env.PI_GIT_HELPER;
    piGit({ on, registerTool } as unknown as ExtensionAPI);
    if (saved !== undefined) process.env.PI_GIT_HELPER = saved;
    expect(registerTool).toHaveBeenCalledTimes(1);
  });
});
