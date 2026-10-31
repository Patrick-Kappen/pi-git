import { homedir } from "node:os";
import { Type } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { gitCheck } from "./check.ts";
import { type Config, loadConfig } from "./config.ts";
import { type Runner, run } from "./exec.ts";
import { repoSlug } from "./git.ts";
import { blockedForHelper } from "./guard.ts";
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

export interface Options {
  env?: NodeJS.ProcessEnv;
  home?: string;
  run?: Runner;
}

/** The pi methods this extension uses; a subset of ExtensionAPI, so tests can pass a fake. */
export type PiGitApi = Pick<ExtensionAPI, "on" | "registerTool" | "sendMessage">;

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
    const origin = await runner("git", ["remote", "get-url", "origin"], { cwd: ctx.cwd });
    slug = origin.code === 0 ? repoSlug(origin.stdout) : undefined;
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
