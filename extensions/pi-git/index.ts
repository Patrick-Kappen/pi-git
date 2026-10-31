import { homedir } from "node:os";
import { Type } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { type Config, loadConfig } from "./config.ts";
import { type Runner, run } from "./exec.ts";
import { blockedForHelper } from "./guard.ts";
import { HELPER_ENV } from "./helper.ts";
import { gitPr, type PrResult } from "./pr.ts";

export interface Options {
  env?: NodeJS.ProcessEnv;
  home?: string;
  run?: Runner;
}

/** The pi methods this extension uses; a subset of ExtensionAPI, so tests can pass a fake. */
export type PiGitApi = Pick<ExtensionAPI, "on" | "registerTool">;

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
  pi.on("session_start", (_event, ctx) => {
    config = loadConfig(env, home);
    if (config.errors.length > 0 && ctx.hasUI) ctx.ui.notify(`pi-git:\n${config.errors.join("\n")}`, "warning");
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
      return {
        content: [{ type: "text", text: result.summary }],
        details: { pr: result.pr, commit: result.commit, notes: result.notes },
      };
    },
  });
}

export default function piGit(pi: ExtensionAPI): void {
  createPiGit(pi);
}
