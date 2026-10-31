import { homedir } from "node:os";
import { Type } from "@earendil-works/pi-ai";
import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { gitCheck } from "./check.ts";
import { type Config, loadConfig } from "./config.ts";
import { type Runner, run } from "./exec.ts";
import { repoSlug } from "./git.ts";
import { blockedForHelper, gitChanges } from "./guard.ts";
import { HELPER_ENV } from "./helper.ts";
import { gitPr, type PrResult } from "./pr.ts";
import {
  claimSummary,
  type Entry,
  endSession,
  entryId,
  heartbeat,
  loadEntries,
  loadSummaries,
  type Summary,
  saveEntry,
  sessionAlive,
} from "./state.ts";
import { effective, type Lock, loadSwitch, setGlobal, setRepo, switchPath } from "./switch.ts";

export interface Options {
  env?: NodeJS.ProcessEnv;
  home?: string;
  run?: Runner;
}

/** The pi methods this extension uses; a subset of ExtensionAPI, so tests can pass a fake. */
export type PiGitApi = Pick<ExtensionAPI, "on" | "registerTool" | "sendMessage" | "registerCommand">;

/** Why a git change is blocked; the model cannot unlock, only the user can. */
export function lockedReason(what: string, slug: string | undefined): string {
  const where = slug ? `in ${slug}` : "outside a repository with an origin";
  return `pi-git: git changes are locked ${where} (${what}). Only the user can unlock them, with /git unlock.`;
}

/** The text of /git. */
export function describeLock(stateDir: string, slug: string | undefined, fallback: Lock): string {
  const value = loadSwitch(stateDir);
  const here = effective(value, slug, fallback);
  const source = { repo: "override of this repository", global: "global setting", default: "default of the settings" }[
    here.source
  ];
  const lines = [
    `git changes ${slug ? `in ${slug}` : "here"}: ${here.lock} (${source})`,
    `global: ${value.global ?? `not set, so the default: ${fallback}`}`,
  ];
  const overrides = Object.entries(value.repos);
  if (overrides.length > 0) lines.push("overrides:", ...overrides.map(([repo, lock]) => `  ${repo}: ${lock}`));
  lines.push("/git unlock | lock | reset: this repository. /git global unlock | lock | reset: everywhere else.");
  return lines.join("\n");
}

/** The name of the system prompt section with the state of the lock. */
export const PROMPT_SECTION = "pi_git";

/** What the agent is told about the lock, before every prompt. */
export function lockPrompt(lock: Lock, slug: string | undefined): string {
  const where = slug ? `in ${slug}` : "here (not in a repository with an origin)";
  if (lock === "unlocked") {
    return [
      `git: unlocked ${where}. You may change the repository; use git_pr to commit, push and open or update PRs.`,
      "Other repositories can be locked; a blocked command says so.",
    ].join("\n");
  }
  return [
    `git: locked ${where}. Git changes are blocked for you: commit, push, add, checkout, branches, rebase,`,
    "worktrees, and gh commands that change GitHub (pr create, pr merge, ...). Reading is allowed: status, diff, log,",
    "fetch, gh pr view, gh pr checks, and the like.",
    "Do not try to work around the lock. When the task needs a git change, finish the work in the files and ask the",
    "user to run /git unlock; only the user can unlock.",
  ].join("\n");
}

const GIT_COMMANDS = ["unlock", "lock", "reset", "global unlock", "global lock", "global reset"];

/** How often a session sends its heartbeat and looks for summaries. */
export const POLL_MS = 20_000;
/** A session without a heartbeat for this long is gone; its summaries go to another session of the repository. */
export const SESSION_MAX_AGE_MS = 90_000;
export const MESSAGE_TYPE = "pi-git";

/** Queue a PR for the watcher. A PR that is already queued starts over: new head, same fixes count. */
export function enqueue(
  config: Config,
  result: PrResult,
  intent: string,
  sessionId: string,
  now = new Date(),
): Entry | undefined {
  const { pr, worktree } = result;
  if (!pr || !worktree) return undefined;
  const id = entryId(worktree.slug, pr.number);
  const previous = loadEntries(config.stateDir).find((entry) => entry.id === id);
  const entry: Entry = {
    id,
    repo: worktree.slug,
    number: pr.number,
    url: pr.url,
    worktree: worktree.root,
    mainRoot: worktree.mainRoot,
    branch: worktree.branch,
    base: result.base ?? worktree.defaultBranch,
    intent,
    sessionId,
    status: "watching",
    attempts: previous?.attempts ?? 0,
    errors: 0,
    notes: previous?.notes ?? [],
    updated: now.toISOString(),
  };
  saveEntry(config.stateDir, entry);
  return entry;
}

/** Whether a session should take a summary: its own, or one of a gone session in the same repository. */
export function takes(
  summary: Summary,
  sessionId: string,
  slug: string | undefined,
  config: Config,
  now = Date.now(),
): boolean {
  if (summary.sessionId === sessionId) return true;
  if (sessionAlive(config.stateDir, summary.sessionId, SESSION_MAX_AGE_MS, now)) return false;
  return slug !== undefined && summary.repo.toLowerCase() === slug.toLowerCase();
}

const PR_DESCRIPTION = [
  "Commit the changes of a worktree, push them and open or update the PR, without doing it by hand.",
  "It stages everything, runs the repository's hooks, lets a helper agent fix failing checks, has it write",
  "the commit message and the PR, and pushes. Call it from a worktree on a <type>/<topic> branch, not",
  "the main checkout. Pass what the change is for; the result says what happened.",
].join(" ");

const prParameters = Type.Object({
  intent: Type.String({
    description: "What the change is for and why, in a few sentences: the basis of the commit message and the PR.",
  }),
  path: Type.Optional(Type.String({ description: "A directory in the worktree; default: the working directory." })),
  base: Type.Optional(
    Type.String({ description: "Base branch; default: that of the open PR, else the default branch." }),
  ),
  draft: Type.Optional(Type.Boolean({ description: "Open the PR as a draft." })),
});

const checkParameters = Type.Object({
  path: Type.Optional(Type.String({ description: "A directory in the repository; default: the working directory." })),
  command: Type.Optional(
    Type.String({
      description:
        "The check command, run with sh -c; default: detected (devenv check, npm test, nix flake check, make).",
    }),
  ),
  fix: Type.Optional(
    Type.Boolean({
      description: "Let the helper fix failures; default: true. With false, only a summary of the failures.",
    }),
  ),
});

/** In a helper process: block git and gh commands that pi-git runs itself. */
export function guardHelper(event: ToolCallEvent): ToolCallEventResult | undefined {
  if (event.toolName !== "bash" || typeof event.input.command !== "string") return undefined;
  const blocked = blockedForHelper(event.input.command);
  if (!blocked) return undefined;
  return {
    block: true,
    reason: `pi-git: the helper does not run ${blocked}; pi-git stages, commits, pushes and talks to GitHub itself.`,
  };
}

export function createPiGit(pi: PiGitApi, options: Options = {}): void {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const runner = options.run ?? run;

  if (env[HELPER_ENV] !== undefined) {
    pi.on("tool_call", (event: ToolCallEvent) => guardHelper(event));
    return;
  }

  let config: Config = loadConfig(env, home);
  const fallback = (): Lock => (config.locked ? "locked" : "unlocked");
  const slugs = new Map<string, string | undefined>();
  const slugOf = async (dir: string): Promise<string | undefined> => {
    if (!slugs.has(dir)) {
      const origin = await runner("git", ["remote", "get-url", "origin"], { cwd: dir });
      slugs.set(dir, origin.code === 0 ? repoSlug(origin.stdout) : undefined);
    }
    return slugs.get(dir);
  };
  const lockOf = (target: string | undefined): Lock => effective(loadSwitch(config.stateDir), target, fallback()).lock;
  const showStatus = (ctx: ExtensionContext, target: string | undefined): void => {
    if (ctx.hasUI) ctx.ui.setStatus("pi-git", `git: ${lockOf(target)}`);
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  let sessionId = "";
  let slug: string | undefined;

  const send = (text: string, ctx: ExtensionContext): void => {
    if (config.delivery === "notify") {
      if (ctx.hasUI) ctx.ui.notify(text, "info");
      return;
    }
    const options =
      config.delivery === "turn"
        ? ({ triggerTurn: true, deliverAs: "followUp" } as const)
        : ({ deliverAs: "nextTurn" } as const);
    pi.sendMessage({ customType: MESSAGE_TYPE, content: text, display: true }, options);
  };

  const deliver = (ctx: ExtensionContext): void => {
    for (const summary of loadSummaries(config.stateDir)) {
      if (takes(summary, sessionId, slug, config) && claimSummary(config.stateDir, summary.id)) send(summary.text, ctx);
    }
  };

  const poll = (ctx: ExtensionContext): void => {
    try {
      heartbeat(config.stateDir, sessionId);
      deliver(ctx);
    } catch {
      // The state directory may not be writable; git_pr still works.
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig(env, home);
    if (config.errors.length > 0 && ctx.hasUI) ctx.ui.notify(`pi-git:\n${config.errors.join("\n")}`, "warning");
    sessionId = ctx.sessionManager.getSessionId();
    slugs.clear();
    slug = await slugOf(ctx.cwd);
    // The global git hooks read these in the agents' processes: a hard stop for locked repositories.
    env.PI_GIT_SWITCH = switchPath(config.stateDir);
    env.PI_GIT_DEFAULT = fallback();
    showStatus(ctx, slug);
    if (timer) clearInterval(timer);
    poll(ctx);
    timer = setInterval(() => poll(ctx), POLL_MS);
    timer.unref?.();
  });

  pi.on("session_shutdown", () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    try {
      if (sessionId) endSession(config.stateDir, sessionId);
    } catch {
      // Nothing to clean up in a state directory that cannot be written.
    }
  });

  pi.on("before_agent_start", (event: BeforeAgentStartEvent) => {
    event.systemPromptOptions.sections[PROMPT_SECTION] = lockPrompt(lockOf(slug), slug);
  });

  pi.on("tool_call", async (event: ToolCallEvent, ctx): Promise<ToolCallEventResult | undefined> => {
    if (event.toolName !== "bash" || typeof event.input.command !== "string") return undefined;
    for (const change of gitChanges(event.input.command, ctx.cwd, home)) {
      const target = change.slug ?? (await slugOf(change.dir));
      if (lockOf(target) === "locked") return { block: true, reason: lockedReason(change.what, target) };
    }
    return undefined;
  });

  pi.registerCommand("git", {
    description: "Lock or unlock git changes by agents: /git [unlock|lock|reset] or /git global [unlock|lock|reset]",
    getArgumentCompletions: (prefix) =>
      GIT_COMMANDS.filter((item) => item.startsWith(prefix.trim())).map((item) => ({ value: item, label: item })),
    handler: async (args, ctx) => {
      const words = args
        .trim()
        .split(/\s+/)
        .filter((word) => word !== "");
      const here = await slugOf(ctx.cwd);
      const action = (word: string | undefined): Lock | undefined | "bad" =>
        word === "lock" ? "locked" : word === "unlock" ? "unlocked" : word === "reset" ? undefined : "bad";
      if (words[0] === "global" && words.length === 2 && action(words[1]) !== "bad") {
        setGlobal(config.stateDir, action(words[1]) as Lock | undefined);
      } else if (words.length === 1 && action(words[0]) !== "bad") {
        if (!here) {
          ctx.ui.notify("pi-git: not in a repository with an origin; use /git global unlock|lock|reset", "warning");
          return;
        }
        setRepo(config.stateDir, here, action(words[0]) as Lock | undefined);
      } else if (words.length > 0) {
        ctx.ui.notify("pi-git: /git [unlock|lock|reset] or /git global [unlock|lock|reset]", "warning");
        return;
      }
      showStatus(ctx, here);
      ctx.ui.notify(describeLock(config.stateDir, here, fallback()), "info");
    },
  });

  pi.registerTool({
    name: "git_pr",
    label: "Git PR",
    description: PR_DESCRIPTION,
    promptSnippet: "Commit, push and open or update the PR of a worktree",
    promptGuidelines: [
      "Use git_pr to commit, push and open or update a PR; do not run git commit, git push or gh pr create yourself.",
    ],
    parameters: prParameters,
    async execute(_id, params, signal, onUpdate, ctx: ExtensionContext) {
      const target = await slugOf(params.path ?? ctx.cwd);
      if (lockOf(target) === "locked") throw new Error(lockedReason("git_pr", target));
      const steps: string[] = [];
      const progress = (text: string) => {
        steps.push(text);
        onUpdate?.({
          content: [{ type: "text", text: steps.map((step) => `- ${step}`).join("\n") }],
          details: undefined,
        });
      };
      const result: PrResult = await gitPr(
        {
          path: params.path ?? ctx.cwd,
          intent: params.intent,
          ...(params.base === undefined ? {} : { base: params.base }),
          ...(params.draft === undefined ? {} : { draft: params.draft }),
        },
        { run: runner, config, progress, signal },
      );
      if (!result.ok) throw new Error(result.summary);
      let text = result.summary;
      try {
        if (enqueue(config, result, params.intent, ctx.sessionManager.getSessionId())) {
          text += "\nThe watcher follows CI and conflicts, and reports back when the PR is green, merged or needs you.";
        }
      } catch (error) {
        text += `\nThe watcher could not queue the PR: ${(error as Error).message}`;
      }
      return {
        content: [{ type: "text", text }],
        details: { pr: result.pr, commit: result.commit, notes: result.notes },
      };
    },
  });

  pi.registerTool({
    name: "git_check",
    label: "Git check",
    description: [
      "Run the checks of a repository (lint, types, tests) without reading their output yourself.",
      'A helper agent fixes failures; you get "passed", or a short summary of what still fails.',
    ].join(" "),
    promptSnippet: "Run the checks of a repository; a helper fixes failures",
    promptGuidelines: ["Use git_check to run a repository's checks or tests instead of running them in bash."],
    parameters: checkParameters,
    async execute(_id, params, signal, onUpdate, ctx: ExtensionContext) {
      const steps: string[] = [];
      const progress = (text: string) => {
        steps.push(text);
        onUpdate?.({
          content: [{ type: "text", text: steps.map((step) => `- ${step}`).join("\n") }],
          details: undefined,
        });
      };
      const result = await gitCheck(
        {
          path: params.path ?? ctx.cwd,
          ...(params.command === undefined ? {} : { command: params.command }),
          ...(params.fix === undefined ? {} : { fix: params.fix }),
        },
        { run: runner, config, progress, signal },
      );
      if (!result.ok) throw new Error(result.summary);
      return {
        content: [{ type: "text", text: result.summary }],
        details: { command: result.command, notes: result.notes },
      };
    },
  });
}

export default function piGit(pi: ExtensionAPI): void {
  createPiGit(pi);
}
