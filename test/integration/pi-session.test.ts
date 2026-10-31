// Runs pi's own session with a scripted model: the extension loads from the agent directory, tells the
// model that git is locked, and blocks a commit; after /git unlock, the commit runs.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getSystemMessageText } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const source = resolve(import.meta.dirname, "../../extensions/pi-git");
const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-git-it-")));
const agentDir = join(root, "agent");
const repo = join(root, "repo");
const stateDir = join(root, "state");
const savedEnv = { ...process.env };

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

beforeAll(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];
  const gitconfig = join(root, "gitconfig");
  writeFileSync(gitconfig, "[user]\n\tname = t\n\temail = t@t\n[init]\n\tdefaultBranch = main\n");
  process.env.GIT_CONFIG_GLOBAL = gitconfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  cpSync(source, join(agentDir, "extensions", "pi-git"), {
    recursive: true,
    filter: (path) => !path.endsWith(".test.ts"),
  });
  writeFileSync(join(agentDir, "pi-git.json"), JSON.stringify({ stateDir, locked: true }));
  mkdirSync(repo);
  git("init", "-q");
  git("remote", "add", "origin", "git@github.com:Example-Owner/example-repo.git");
  writeFileSync(join(repo, "a.txt"), "a\n");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_GIT_CONFIG;
});

afterAll(() => {
  process.env = savedEnv;
  rmSync(root, { recursive: true, force: true });
});

function text(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content.map((block: { type: string; text?: string }) => (block.type === "text" ? block.text : "")).join("\n");
}

describe("pi applies the pi-git lock", () => {
  test("the model is told git is locked, a commit is blocked; after /git unlock it runs", async () => {
    const faux = fauxProvider();
    const modelRuntime = await ModelRuntime.create({
      authPath: join(root, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    const commit = "git add -A && git commit -q -m first";
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "git status --short" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("bash", { command: commit }), { stopReason: "toolUse" }),
      fauxAssistantMessage("blocked, asking the user"),
      fauxAssistantMessage(fauxToolCall("bash", { command: commit }), { stopReason: "toolUse" }),
      fauxAssistantMessage("committed"),
    ]);
    const resourceLoader = new DefaultResourceLoader({ cwd: repo, agentDir });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: repo,
      agentDir,
      model: faux.getModel(),
      modelRuntime,
      resourceLoader,
      settingsManager: SettingsManager.inMemory(),
      sessionManager: SessionManager.inMemory(repo),
    });
    await session.bindExtensions({});
    await session.prompt("commit it");
    const system = () =>
      session.messages
        .filter((message) => message.role === "system")
        .map((message) => getSystemMessageText(message))
        .join("\n");
    expect(system()).toContain("git: locked in Example-Owner/example-repo.");
    const results = session.messages.filter((message) => message.role === "toolResult").map(text);
    expect(results[0]).toContain("?? a.txt");
    expect(results[1]).toContain("commit is locked in Example-Owner/example-repo (git add)");
    // No commit: the repository has no HEAD yet.
    expect(() => git("rev-parse", "--verify", "-q", "HEAD")).toThrow();
    try {
      await session.prompt("/git unlock commit");
      await session.prompt("now commit");
      expect(system()).toContain("git: commit unlocked in Example-Owner/example-repo.");
      expect(git("log", "--format=%s")).toBe("first");
    } finally {
      session.dispose();
    }
  });
});
