import { homedir } from "node:os";
import { Type } from "@earendil-works/pi-ai";
import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { type Attention, addAttention, clearAttention, listAttention, notifyTerminals } from "./attention.ts";
import { gitCheck } from "./check.ts";
import { type Config, loadConfig } from "./config.ts";
import { type Runner, run } from "./exec.ts";
import { repoSlug } from "./git.ts";
import { blockedForHelper, gitChanges } from "./guard.ts";
import { HELPER_ENV } from "./helper.ts";
import {
  describeLock,
  type GitCommand,
  gitCompletions,
  lockedReason,
  lockPrompt,
  parseGitCommand,
  statesOf,
  statusText,
} from "./lock.ts";
import { gitCommit, gitPr, gitPush, type PrResult } from "./pr.ts";
import { shipCommand } from "./ship-command.ts";
import { findMainCheckout, gitStart, TYPES } from "./start.ts";
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
import { gitStatus, gitWatch } from "./status.ts";
import { effective, type Lock, loadSwitch, STEPS, type Step, setGlobal, setRepo, switchPath } from "./switch.ts";

export interface Options {
  env?: NodeJS.ProcessEnv;
  home?: string;
  run?: Runner;
}

/** The pi methods this extension uses; a subset of ExtensionAPI, so tests can pass a fake. */
export type PiGitApi = Pick<ExtensionAPI, "on" | "registerTool" | "sendMessage" | "registerCommand"> &
  Partial<Pick<ExtensionAPI, "events">>;

/**
 * The event other extensions use to hand an open PR to the watcher, like git_watch:
 * `pi.events.emit(WATCH_EVENT, { pr, path, reply })`. `path` is a worktree with the PR's branch;
 * `reply`, when given, gets the outcome. pi-orchestrator uses it for the PRs of its tasks.
 */
export const WATCH_EVENT = "pi-git:watch";

export interface WatchRequest {
  pr: string;
  path: string;
  reply?: (result: { ok: boolean; summary: string }) => void;
}

function isWatchRequest(data: unknown): data is WatchRequest {
  const request = data as Partial<WatchRequest> | null;
  return (
    typeof request === "object" &&
    request !== null &&
    typeof request.pr === "string" &&
    typeof request.path === "string" &&
    (request.reply === undefined || typeof request.reply === "function")
  );
}

/** The name of the system prompt section with the state of the lock. */
export const PROMPT_SECTION = "pi_git";

const GIT_USAGE =
  "pi-git: /git, /git unlock|lock|reset [worktree commit push pr], /git global unlock|lock|reset [steps], /git worktree <topic> [type], /git commit|push|pr [intent], /git clear";

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
  if (sessionAlive(config.runtimeDir, summary.sessionId, SESSION_MAX_AGE_MS, now)) return false;
  return slug !== undefined && summary.repo.toLowerCase() === slug.toLowerCase();
}

function watcherNotice(config: Config, result: PrResult, intent: string, sessionId: string): string | undefined {
  try {
    if (enqueue(config, result, intent, sessionId)) {
      return "\nThe watcher follows CI and conflicts, and reports back when the PR is green, merged or needs you.";
    }
  } catch (error) {
    return `\nThe watcher could not queue the PR: ${(error as Error).message}`;
  }
  return undefined;
}

const PR_DESCRIPTION = [
  "Commit the changes of a worktree, push them and open or update the PR, without doing it by hand.",
  "It stages everything, runs the repository's hooks, lets a helper agent fix failing checks, has it write",
  "the commit message and the PR, and pushes. Call it from a worktree on a <type>/<topic> branch, not",
  "the main checkout. Pass what the change is for; the result says what happened.",
].join(" ");

const prParameters = Type.Object({
  title: Type.Optional(
    Type.String({
      description:
        "The commit subject and PR title in the repository's style, e.g. fix(api): retry timeouts. With it, no helper writes them.",
    }),
  ),
  intent: Type.String({
    description: "What the change is for and why, in a few sentences: the basis of the commit message and the PR.",
  }),
  path: Type.Optional(Type.String({ description: "A directory in the worktree; default: the working directory." })),
  base: Type.Optional(
    Type.String({ description: "Base branch; default: that of the open PR, else the default branch." }),
  ),
  draft: Type.Optional(Type.Boolean({ description: "Open the PR as a draft." })),
});

const commitParameters = Type.Object({
  title: Type.Optional(
    Type.String({
      description:
        "The commit subject and PR title in the repository's style, e.g. fix(api): retry timeouts. With it, no helper writes them.",
    }),
  ),
  intent: Type.String({ description: "What the change is for and why: the basis of the commit message." }),
  path: Type.Optional(Type.String({ description: "A directory in the worktree; default: the working directory." })),
});

const statusParameters = Type.Object({});

const watchParameters = Type.Object({
  pr: Type.String({ description: "The PR: its number or URL." }),
  path: Type.Optional(Type.String({ description: "A directory in the repository; default: the working directory." })),
});

const startParameters = Type.Object({
  topic: Type.String({ description: "Short, lower case, with -: what the change is about, e.g. login-timeout." }),
  type: Type.Optional(
    Type.Union(
      TYPES.map((type) => Type.Literal(type)),
      { description: "The kind of change; default feat. The branch is <type>/<topic>." },
    ),
  ),
  base: Type.Optional(
    Type.String({
      description: "Base branch; default: the default branch. For a stacked change, the branch it needs.",
    }),
  ),
  repo: Type.Optional(
    Type.String({
      description: "The repository: a directory in it, owner/name, or name; default: the working directory.",
    }),
  ),
  setup: Type.Optional(
    Type.Boolean({ description: "Run the repository's setup (devenv, npm ci, uv sync); default: true." }),
  ),
});

const pushParameters = Type.Object({
  path: Type.Optional(Type.String({ description: "A directory in the worktree; default: the working directory." })),
  intent: Type.Optional(
    Type.String({ description: "What the branch is for; used when the helper has to commit a fix." }),
  ),
});

const requestParameters = Type.Object({
  reason: Type.String({ description: "What you need from the user and why, in one or two sentences." }),
  step: Type.Optional(
    Type.Union(
      STEPS.map((step) => Type.Literal(step)),
      { description: "The locked step the work needs, if any." },
    ),
  ),
  path: Type.Optional(Type.String({ description: "A directory in the repository; default: the working directory." })),
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
  const lockOf = (target: string | undefined, step: Step): Lock =>
    effective(loadSwitch(config.stateDir), target, step, fallback(), config.repos).lock;
  const showStatus = (ctx: ExtensionContext, target: string | undefined): void => {
    const waiting = listAttention(config.stateDir).length;
    const text = statusText(statesOf(config.stateDir, target, fallback(), config.repos));
    if (ctx.hasUI) ctx.ui.setStatus("pi-git", waiting > 0 ? `${text} ● ${waiting}` : text);
  };
  /** Something needs the user: remember it (the tmux sign shows it) and notify once. */
  const needYou = (ctx: ExtensionContext, item: Omit<Attention, "id" | "created">): void => {
    try {
      const { fresh } = addAttention(config.stateDir, item);
      if (!fresh) return;
      if (ctx.hasUI) ctx.ui.notify(item.text, "warning");
      void notifyTerminals(runner, "pi-git", item.text).catch(() => 0);
      showStatus(ctx, slug);
    } catch {
      // A state directory that cannot be written: the agent still gets the reason.
    }
  };
  const blocked = (ctx: ExtensionContext, step: Step, what: string, target: string | undefined): void =>
    needYou(ctx, {
      kind: "blocked",
      ...(target ? { repo: target } : {}),
      step,
      text: `The agent wanted ${what} ${target ? `in ${target}` : "here"}, but ${step} is locked: /git unlock ${step}, or /git ${step} once.`,
    });
  /** Forget what an unlock or a one-time action answered: items about those steps, not questions. */
  const answered = (repo: string | undefined, steps: readonly Step[]): void => {
    clearAttention(
      config.stateDir,
      (item) =>
        item.kind !== "watcher" &&
        (repo === undefined || item.repo?.toLowerCase() === repo.toLowerCase()) &&
        item.step !== undefined &&
        (steps.length === 0 || steps.includes(item.step)),
    );
  };
  const progressOf = (
    onUpdate: ((update: { content: Array<{ type: "text"; text: string }>; details: undefined }) => void) | undefined,
  ) => {
    const steps: string[] = [];
    return (text: string) => {
      steps.push(text);
      onUpdate?.({
        content: [{ type: "text", text: steps.map((step) => `- ${step}`).join("\n") }],
        details: undefined,
      });
    };
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  let sessionId = "";
  let slug: string | undefined;

  /**
   * A summary goes into the agent's history once. Only a PR that needs the agent (the watcher gave
   * up: status failed) starts a turn with `delivery: turn`; green, merged, closed and waiting PRs are
   * added quietly, for the next prompt.
   */
  const send = (summary: Summary, ctx: ExtensionContext): void => {
    if (config.delivery === "notify") {
      if (ctx.hasUI) ctx.ui.notify(summary.text, "info");
      return;
    }
    const options =
      config.delivery === "turn" && summary.status === "failed"
        ? ({ triggerTurn: true, deliverAs: "followUp" } as const)
        : ({ deliverAs: "nextTurn" } as const);
    pi.sendMessage({ customType: MESSAGE_TYPE, content: summary.text, display: true }, options);
  };

  const deliver = (ctx: ExtensionContext): void => {
    for (const summary of loadSummaries(config.stateDir)) {
      if (takes(summary, sessionId, slug, config) && claimSummary(config.stateDir, summary.id)) send(summary, ctx);
    }
  };

  const poll = (ctx: ExtensionContext): void => {
    try {
      heartbeat(config.runtimeDir, sessionId);
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
    env.PI_GIT_REPOS = JSON.stringify(config.repos);
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
      if (sessionId) endSession(config.runtimeDir, sessionId);
    } catch {
      // Nothing to clean up in a state directory that cannot be written.
    }
  });

  pi.on("before_agent_start", (event: BeforeAgentStartEvent) => {
    event.systemPromptOptions.sections[PROMPT_SECTION] = lockPrompt(
      statesOf(config.stateDir, slug, fallback(), config.repos),
      slug,
    );
  });

  pi.on("tool_call", async (event: ToolCallEvent, ctx): Promise<ToolCallEventResult | undefined> => {
    if (event.toolName !== "bash" || typeof event.input.command !== "string") return undefined;
    for (const change of gitChanges(event.input.command, ctx.cwd, home)) {
      const target = change.slug ?? (await slugOf(change.dir));
      if (lockOf(target, change.step) === "locked") {
        blocked(ctx, change.step, change.what, target);
        return { block: true, reason: lockedReason(change.step, change.what, target) };
      }
    }
    return undefined;
  });

  /** One step as the user's own action: allowed whatever the lock says. */
  const stepOnce = (step: Step, args: string, ctx: ExtensionContext): Promise<{ ok: boolean; summary: string }> => {
    const deps = { run: runner, config, progress: () => {} };
    const intent = args || "(no intent given: describe the change from the diff)";
    const steps: Record<Step, () => Promise<{ ok: boolean; summary: string }>> = {
      worktree: () => {
        const [topic = "", type] = args.split(/\s+/);
        return gitStart({ repo: ctx.cwd, topic, ...(type ? { type } : {}) }, { ...deps, home });
      },
      commit: () => gitCommit({ path: ctx.cwd, intent }, deps),
      push: () => gitPush({ path: ctx.cwd, intent }, deps),
      pr: async () => {
        const pr = await gitPr({ path: ctx.cwd, intent }, deps);
        if (pr.ok) enqueue(config, pr, intent, ctx.sessionManager.getSessionId());
        return pr;
      },
    };
    return steps[step]();
  };

  /** /git <step>: the user's own action, allowed once whatever the lock says. */
  const runOnce = async (step: Step, args: string, ctx: ExtensionContext): Promise<void> => {
    const result = await stepOnce(step, args, ctx);
    if (result.ok) answered(await slugOf(ctx.cwd), [step]);
    ctx.ui.notify(result.summary, result.ok ? "info" : "error");
  };

  const applySet = (command: Extract<GitCommand, { kind: "set" }>, here: string | undefined): void => {
    if (command.scope === "global") setGlobal(config.stateDir, command.steps, command.lock);
    else setRepo(config.stateDir, here as string, command.steps, command.lock);
    if (command.lock === "unlocked") answered(command.scope === "global" ? undefined : here, command.steps);
  };

  /** The attention list, for /git. */
  const waitingText = (): string => {
    const items = listAttention(config.stateDir);
    return items.length === 0 ? "" : `\nneeds you:\n${items.map((item) => `- ${item.text}`).join("\n")}`;
  };

  pi.registerCommand("git", {
    description:
      "Lock or unlock what agents may do with git (/git unlock|lock|reset [steps], /git global ...), or /git commit once",
    getArgumentCompletions: (prefix) => gitCompletions(prefix),
    handler: async (args, ctx) => {
      const command = parseGitCommand(args);
      const here = await slugOf(ctx.cwd);
      if (command.kind === "bad") {
        ctx.ui.notify(GIT_USAGE, "warning");
      } else if (command.kind === "run") {
        await runOnce(command.step, command.args, ctx);
      } else if (command.kind === "clear") {
        const count = clearAttention(config.stateDir, () => true);
        showStatus(ctx, here);
        ctx.ui.notify(`pi-git: forgot ${count} item(s) that needed you`, "info");
      } else if (command.kind === "set" && command.scope === "repo" && !here) {
        ctx.ui.notify("pi-git: not in a repository with an origin; use /git global unlock|lock|reset", "warning");
      } else {
        if (command.kind === "set") applySet(command, here);
        showStatus(ctx, here);
        ctx.ui.notify(`${describeLock(config.stateDir, here, fallback(), config.repos)}${waitingText()}`, "info");
      }
    },
  });

  pi.registerCommand("ship", {
    description: "Merge what is ready, release what you pick, lock it in NixOS and wait for the deploy (/ship status)",
    handler: (args, ctx) => shipCommand(args, ctx.ui, { run: runner, config }),
  });

  pi.registerTool({
    name: "git_request",
    label: "Git request",
    description: [
      "Tell the user that the work needs them: a locked step (commit, push, pr, worktree) that a real change needs, or",
      "a decision only they can make. The user gets a notification; do not work around the lock, and wait for them.",
    ].join(" "),
    promptSnippet: "Tell the user the work needs them (a locked step, a decision)",
    promptGuidelines: [
      "Use git_request when a locked git step or a decision of the user blocks the task; then stop and wait.",
    ],
    parameters: requestParameters,
    async execute(_id, params, _signal, _onUpdate, ctx: ExtensionContext) {
      const target = await slugOf(params.path ?? ctx.cwd);
      const step = params.step as Step | undefined;
      // The agent often names the commands itself; add them only when it did not.
      const how = step && !params.reason.includes("/git ") ? ` /git unlock ${step}, or /git ${step} once.` : "";
      // A request for a step replaces the item of the blocked call that led to it.
      if (step) {
        clearAttention(
          config.stateDir,
          (item) => item.kind === "blocked" && item.step === step && item.repo?.toLowerCase() === target?.toLowerCase(),
        );
      }
      needYou(ctx, {
        kind: "request",
        ...(target ? { repo: target } : {}),
        ...(step ? { step } : {}),
        text: `${target ? `${target}: ` : ""}${params.reason}${how}`,
      });
      return {
        content: [
          { type: "text", text: "The user is notified. Do not work around it; stop here until the user answers." },
        ],
        details: undefined,
      };
    },
  });

  pi.registerTool({
    name: "git_status",
    label: "Git status",
    description: [
      "Show all git work in progress, across repositories: the PRs the watcher follows and their state, what needs the",
      "user, and the worktrees with uncommitted or unpushed work. Reads only.",
    ].join(" "),
    promptSnippet: "Show all git work in progress: watched PRs, what needs the user, worktrees",
    promptGuidelines: ["Use git_status to see open work instead of listing worktrees and PRs by hand."],
    parameters: statusParameters,
    async execute() {
      const text = await gitStatus({ run: runner, config, home });
      return { content: [{ type: "text", text }], details: undefined };
    },
  });

  pi.events?.on(WATCH_EVENT, (data) => {
    if (!isWatchRequest(data)) return;
    gitWatch({ run: runner, config, home }, { pr: data.pr, path: data.path, sessionId, quiet: true })
      .then((result) => data.reply?.({ ok: result.ok, summary: result.summary }))
      .catch((error: unknown) => data.reply?.({ ok: false, summary: (error as Error).message }));
  });

  pi.registerTool({
    name: "git_watch",
    label: "Git watch",
    description: [
      "Hand an open PR that was not made with git_pr to the watcher, so it fixes CI and conflicts, cleans up after the",
      "merge and reports back. Needs a worktree with the PR's branch checked out.",
    ].join(" "),
    promptSnippet: "Let the watcher follow an open PR that was made without git_pr",
    promptGuidelines: ["After git_watch, do not watch CI yourself; the watcher reports back."],
    parameters: watchParameters,
    async execute(_id, params, _signal, _onUpdate, ctx: ExtensionContext) {
      const result = await gitWatch(
        { run: runner, config, home },
        { pr: params.pr, path: params.path ?? ctx.cwd, sessionId: ctx.sessionManager.getSessionId() },
      );
      if (!result.ok) throw new Error(result.summary);
      return { content: [{ type: "text", text: result.summary }], details: undefined };
    },
  });

  pi.registerTool({
    name: "git_start",
    label: "Git start",
    description: [
      "Start a change: fetch, create the worktree <worktrees>/<repo>/<topic> on <type>/<topic> from the fresh base",
      "branch, and run the repository's setup. Returns the path and what to know about the repository (default branch,",
      "commit style, checks, other worktrees). Make the change in that path, then call git_pr.",
    ].join(" "),
    promptSnippet: "Create the worktree and branch of a new change, with its setup",
    promptGuidelines: [
      "Use git_start to start every change; never edit in the main checkout or on the default branch.",
    ],
    parameters: startParameters,
    async execute(_id, params, signal, onUpdate, ctx: ExtensionContext) {
      const deps = { run: runner, config, home, progress: progressOf(onUpdate), signal };
      const repo = params.repo ?? ctx.cwd;
      const main = await findMainCheckout(deps, repo);
      if (typeof main !== "string") throw new Error(main.error);
      const target = await slugOf(main);
      if (lockOf(target, "worktree") === "locked") {
        blocked(ctx, "worktree", "git_start", target);
        throw new Error(lockedReason("worktree", "git_start", target));
      }
      const result = await gitStart(
        {
          repo,
          topic: params.topic,
          ...(params.type === undefined ? {} : { type: params.type }),
          ...(params.base === undefined ? {} : { base: params.base }),
          ...(params.setup === undefined ? {} : { setup: params.setup }),
        },
        deps,
      );
      if (!result.ok) throw new Error(result.summary);
      return {
        content: [{ type: "text", text: result.summary }],
        details: { path: result.path, branch: result.branch },
      };
    },
  });

  pi.registerTool({
    name: "git_push",
    label: "Git push",
    description: [
      "Push the commits of a worktree. The pre-push checks run first; a helper agent fixes failures (as a new commit).",
      "Uncommitted changes are not pushed: commit them with git_commit first.",
    ].join(" "),
    promptSnippet: "Push the commits of a worktree; a helper fixes failing checks",
    promptGuidelines: ["Use git_push to push; do not run git push yourself."],
    parameters: pushParameters,
    async execute(_id, params, signal, onUpdate, ctx: ExtensionContext) {
      const path = params.path ?? ctx.cwd;
      const target = await slugOf(path);
      if (lockOf(target, "push") === "locked") {
        blocked(ctx, "push", "git_push", target);
        throw new Error(lockedReason("push", "git_push", target));
      }
      const allowed = (step: Step) => lockOf(target, step) === "unlocked";
      const deps = { run: runner, config, progress: progressOf(onUpdate), signal, allowed };
      const result = await gitPush({ path, intent: params.intent ?? "Fix the failing pre-push checks." }, deps);
      if (!result.ok) throw new Error(result.summary);
      return { content: [{ type: "text", text: result.summary }], details: { notes: result.notes } };
    },
  });

  pi.registerTool({
    name: "git_commit",
    label: "Git commit",
    description: [
      "Commit all changes of a worktree. pi-git stages everything and runs the pre-commit checks; a helper agent fixes",
      "failures and writes the commit message. Pass what the change is for.",
    ].join(" "),
    promptSnippet: "Commit all changes of a worktree; a helper writes the message",
    promptGuidelines: ["Use git_commit to commit; do not run git commit yourself."],
    parameters: commitParameters,
    async execute(_id, params, signal, onUpdate, ctx: ExtensionContext) {
      const path = params.path ?? ctx.cwd;
      const target = await slugOf(path);
      if (lockOf(target, "commit") === "locked") {
        blocked(ctx, "commit", "git_commit", target);
        throw new Error(lockedReason("commit", "git_commit", target));
      }
      const result = await gitCommit(
        { path, intent: params.intent, ...(params.title ? { title: params.title } : {}) },
        { run: runner, config, progress: progressOf(onUpdate), signal },
      );
      if (!result.ok) throw new Error(result.summary);
      return {
        content: [{ type: "text", text: result.summary }],
        details: { commit: result.commit, notes: result.notes },
      };
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
      const allowed = (step: Step) => lockOf(target, step) === "unlocked";
      const progress = progressOf(onUpdate);
      const result: PrResult = await gitPr(
        {
          path: params.path ?? ctx.cwd,
          intent: params.intent,
          ...(params.title ? { title: params.title } : {}),
          ...(params.base === undefined ? {} : { base: params.base }),
          ...(params.draft === undefined ? {} : { draft: params.draft }),
        },
        { run: runner, config, progress, signal, allowed },
      );
      if (result.stopped) blocked(ctx, result.stopped, "git_pr", target);
      if (!result.ok) throw new Error(result.summary);
      const text =
        result.summary + (watcherNotice(config, result, params.intent, ctx.sessionManager.getSessionId()) ?? "");
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
