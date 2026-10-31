import { effective, isStep, type Lock, loadSwitch, STEPS, type Step } from "./switch.ts";

/** The state of every step in a repository. */
export type States = Record<Step, Lock>;

export function statesOf(stateDir: string, slug: string | undefined, fallback: Lock): States {
  const value = loadSwitch(stateDir);
  return Object.fromEntries(STEPS.map((step) => [step, effective(value, slug, step, fallback).lock])) as States;
}

function where(slug: string | undefined): string {
  return slug ? `in ${slug}` : "outside a repository with an origin";
}

/** Why a step is blocked; the model cannot unlock, only the user can. */
export function lockedReason(step: Step, what: string, slug: string | undefined): string {
  return `pi-git: ${step} is locked ${where(slug)} (${what}). Only the user can allow it: /git unlock ${step}, or /git ${step} for one time.`;
}

/** The footer: `git: locked`, `git: unlocked`, or the unlocked steps. */
export function statusText(states: States): string {
  const open = STEPS.filter((step) => states[step] === "unlocked");
  if (open.length === 0) return "git: locked";
  if (open.length === STEPS.length) return "git: unlocked";
  return `git: ${open.join(", ")} unlocked`;
}

const STEP_TEXT: Record<Step, string> = {
  worktree: "worktree: creating and removing worktrees and branches",
  commit:
    "commit: committing (git_commit), and git commands that change the history or the files (add, reset, rebase, ...)",
  push: "push: pushing",
  pr: "pr: opening and changing PRs, and other gh commands that change GitHub",
};

/** What the agent is told about the lock, before every prompt. */
export function lockPrompt(states: States, slug: string | undefined): string {
  const open = STEPS.filter((step) => states[step] === "unlocked");
  const closed = STEPS.filter((step) => states[step] === "locked");
  const lines = [`${statusText(states)} ${slug ? `in ${slug}` : "here (not in a repository with an origin)"}.`];
  if (open.length > 0)
    lines.push(
      `Allowed: ${open.join(", ")}. Use the pi-git tools: git_commit, and git_pr to commit, push and open the PR.`,
    );
  if (closed.length > 0) {
    lines.push("Blocked for you:", ...closed.map((step) => `- ${STEP_TEXT[step]}`));
    lines.push(
      "Reading is always allowed: status, diff, log, fetch, gh pr view, gh pr checks, and the like.",
      "Do not try to work around a lock. When the task needs a blocked step, finish the work in the files and ask the",
      "user to run /git unlock <step>, or /git <step> for one time; only the user can.",
    );
  }
  lines.push("Other repositories can have other locks; a blocked command says so.");
  return lines.join("\n");
}

/** The text of /git: the state of every step here, and where it comes from. */
export function describeLock(stateDir: string, slug: string | undefined, fallback: Lock): string {
  const value = loadSwitch(stateDir);
  const lines = [`git ${slug ? `in ${slug}` : "here"}:`];
  for (const step of STEPS) {
    const state = effective(value, slug, step, fallback);
    const source = { repo: "this repository", global: "global", default: "default" }[state.source];
    lines.push(`  ${step.padEnd(8)} ${state.lock.padEnd(8)} (${source})`);
  }
  const overrides = Object.entries(value.repos);
  if (overrides.length > 0) {
    lines.push("overrides:", ...overrides.map(([repo, setting]) => `  ${repo}: ${JSON.stringify(setting)}`));
  }
  lines.push(
    "/git unlock|lock|reset [steps]: this repository. /git global unlock|lock|reset [steps]: everywhere else.",
    "/git commit [intent]: commit once, also when commit is locked. /git clear: forget what needs you.",
  );
  return lines.join("\n");
}

/** What a /git command asks for. */
export type GitCommand =
  | { kind: "show" }
  | { kind: "set"; scope: "repo" | "global"; steps: Step[]; lock: Lock | undefined }
  | { kind: "run"; step: "commit"; intent: string }
  | { kind: "clear" }
  | { kind: "bad" };

const ACTIONS: Record<string, Lock | undefined> = { lock: "locked", unlock: "unlocked", reset: undefined };

/** Parse the arguments of /git. */
export function parseGitCommand(args: string): GitCommand {
  const words = args
    .trim()
    .split(/\s+/)
    .filter((word) => word !== "");
  if (words.length === 0) return { kind: "show" };
  if (words[0] === "commit") return { kind: "run", step: "commit", intent: words.slice(1).join(" ") };
  if (words[0] === "clear" && words.length === 1) return { kind: "clear" };
  const scope = words[0] === "global" ? "global" : "repo";
  const rest = scope === "global" ? words.slice(1) : words;
  const [action, ...steps] = rest;
  if (action === undefined || !(action in ACTIONS) || !steps.every(isStep)) return { kind: "bad" };
  return { kind: "set", scope, steps: steps as Step[], lock: ACTIONS[action] };
}

/** Completions for /git. */
export function gitCompletions(prefix: string): Array<{ value: string; label: string }> {
  const items = [
    "unlock",
    "lock",
    "reset",
    ...STEPS.flatMap((step) => [`unlock ${step}`, `lock ${step}`]),
    "global unlock",
    "global lock",
    "global reset",
    "commit",
    "clear",
  ];
  return items.filter((item) => item.startsWith(prefix.trim())).map((item) => ({ value: item, label: item }));
}
