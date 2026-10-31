import type { Runner, RunResult } from "./exec.ts";
import { clipEnd, outputOf } from "./exec.ts";

// The preflight of a ship: before the first merge, every PR of a repository is merged locally, oldest
// first, onto the fresh default branch and onto each other (git merge-tree, nothing is written to a
// branch). So the ship knows in advance which PR is clean and which conflicts, in which files and
// against which earlier PR, and an agent decides what to ship, fix or skip before anything happens.

export interface Simulated {
  number: number;
  clean: boolean;
  /** The files the PR changes. */
  files: string[];
  /** The files that conflict, when not clean. */
  conflicts: string[];
  /** Earlier PRs of the same ship that change a conflicting file. */
  against: number[];
  /** The conflicting files with their markers, clipped. */
  markers: string;
}

/** Commits made only to continue the simulation; never pushed, never on a branch. */
const IDENTITY = {
  GIT_AUTHOR_NAME: "pi-git ship",
  GIT_AUTHOR_EMAIL: "pi-git@localhost",
  GIT_COMMITTER_NAME: "pi-git ship",
  GIT_COMMITTER_EMAIL: "pi-git@localhost",
  PI_GIT_SWITCH: "",
};

const MARKERS_PER_FILE = 3000;

export interface SimItem {
  number: number;
  /** A stacked PR: the PR it builds on. */
  onto?: number | undefined;
  /** PRs that must land before this one (it uses what they add). */
  after?: number[] | undefined;
}

/**
 * Find the order in which the PRs land, the way one merges by hand: again and again the oldest PR
 * that merges cleanly onto what landed so far (a stacked PR only after its base, a PR only after the
 * PRs it needs). PRs that conflict move back; when nothing lands cleanly any more, the rest
 * conflicts, and each is fixed once, on the final state. Nothing is written to a branch.
 * Returns the PRs in that order; a string is why it could not run.
 */
export async function simulate(
  run: Runner,
  main: string,
  base: string,
  items: readonly SimItem[],
): Promise<Simulated[] | string> {
  const git: GitCommand = (...args) => run("git", args, { cwd: main, env: IDENTITY });
  // The full source name: with the short "pull/N/head", a second fetch deletes the local ref.
  const refs = items.map(({ number }) => `+refs/pull/${number}/head:refs/pi-git/ship/${number}`);
  const fetched = await git("fetch", "origin", base, ...refs);
  if (fetched.code !== 0) return `git fetch failed: ${clipEnd(outputOf(fetched), 300)}`;

  const start = (await git("rev-parse", `origin/${base}`)).stdout.trim();
  const files = await changedFiles(git, start, items);
  const state = await landCleanItems(git, start, items, files);
  await describePendingItems(git, state);
  return state.result;
}

type GitCommand = (...args: string[]) => Promise<RunResult>;

interface SimulationState {
  current: string;
  pending: SimItem[];
  landed: number[];
  result: Simulated[];
  files: Map<number, string[]>;
}

async function changedFiles(git: GitCommand, start: string, items: readonly SimItem[]) {
  const files = new Map<number, string[]>();
  for (const { number, onto } of items) {
    const from = onto === undefined ? start : `refs/pi-git/ship/${onto}`;
    const changed = await git("diff", "--name-only", `${from}...refs/pi-git/ship/${number}`);
    files.set(number, changed.stdout.split("\n").filter(Boolean));
  }
  return files;
}

async function tryMerge(git: GitCommand, current: string, { number, onto }: SimItem) {
  const mergeBase = onto === undefined ? [] : [`--merge-base=refs/pi-git/ship/${onto}`];
  const merged = await git(
    "merge-tree",
    "--write-tree",
    "--name-only",
    "--no-messages",
    ...mergeBase,
    current,
    `refs/pi-git/ship/${number}`,
  );
  const [tree = "", ...rest] = merged.stdout.trim().split("\n");
  return { clean: merged.code === 0, tree, conflicts: rest.filter(Boolean) };
}

function ready(item: SimItem, pending: SimItem[]) {
  return [item.onto, ...(item.after ?? [])].every(
    (need) => need === undefined || !pending.some((other) => other.number === need),
  );
}

async function landCleanItems(
  git: GitCommand,
  start: string,
  items: readonly SimItem[],
  files: Map<number, string[]>,
): Promise<SimulationState> {
  const state: SimulationState = { current: start, pending: [...items], landed: [], result: [], files };
  for (;;) {
    const next = await nextCleanItem(git, state);
    if (!next) break;
    await landItem(git, state, next.item, next.tree);
  }
  return state;
}

async function nextCleanItem(git: GitCommand, state: SimulationState) {
  for (const item of state.pending.filter((candidate) => ready(candidate, state.pending))) {
    const merged = await tryMerge(git, state.current, item);
    if (merged.clean) return { item, tree: merged.tree };
  }
  return undefined;
}

async function landItem(git: GitCommand, state: SimulationState, item: SimItem, tree: string) {
  const commit = await git(
    "commit-tree",
    tree,
    "-p",
    state.current,
    "-p",
    `refs/pi-git/ship/${item.number}`,
    "-m",
    `ship: #${item.number}`,
  );
  if (commit.code === 0) state.current = commit.stdout.trim();
  state.pending.splice(state.pending.indexOf(item), 1);
  state.landed.push(item.number);
  state.result.push({
    number: item.number,
    clean: true,
    files: state.files.get(item.number) ?? [],
    conflicts: [],
    against: [],
    markers: "",
  });
}

async function describePendingItems(git: GitCommand, state: SimulationState) {
  // Nothing lands cleanly any more: the rest conflicts with what landed, in their order.
  for (const item of state.pending) {
    const merged = await tryMerge(git, state.current, item);
    const against = state.landed.filter((other) =>
      (state.files.get(other) ?? []).some((file) => merged.conflicts.includes(file)),
    );
    const parts: string[] = [];
    for (const file of merged.conflicts.slice(0, 5)) {
      const shown = await git("show", `${merged.tree}:${file}`);
      parts.push(`--- ${file}\n${clipEnd(conflictRegions(shown.stdout), MARKERS_PER_FILE)}`);
    }
    state.result.push({
      number: item.number,
      clean: merged.clean,
      files: state.files.get(item.number) ?? [],
      conflicts: merged.conflicts,
      against,
      markers: parts.join("\n"),
    });
  }
}

/** Only the parts of a file around conflict markers, with a little context. */
export function conflictRegions(text: string, context = 3): string {
  const lines = text.split("\n");
  const keep = new Set<number>();
  let inside = false;
  lines.forEach((line, index) => {
    if (line.startsWith("<<<<<<<")) inside = true;
    if (inside) for (let i = index - context; i <= index + context; i++) keep.add(i);
    if (line.startsWith(">>>>>>>")) inside = false;
  });
  const out: string[] = [];
  let last = -2;
  for (const index of [...keep].filter((i) => i >= 0 && i < lines.length).sort((a, b) => a - b)) {
    if (index !== last + 1) out.push("…");
    out.push(lines[index] ?? "");
    last = index;
  }
  return out.join("\n");
}

export type Action = "ship" | "fix" | "skip";

export interface Verdict {
  pr: number;
  action: Action;
  reason: string;
  /** PRs that must land first, because this one uses what they add (not for plain file overlap). */
  after?: number[];
}

export const PREFLIGHT_PROMPT = [
  "You check the open PRs of one repository before pi-git /ship merges them, oldest first. The input has",
  "every PR (title, body, changed files, the state of its checks) and a local simulation: the PRs merged in",
  "the order they land cleanly, and the ones that still conflict, with the conflicting files and markers.",
  "",
  "Decide per PR:",
  '- "ship": it merges cleanly, or its checks only still run.',
  '- "fix": it conflicts or its checks fail, and a helper can resolve that without changing behavior',
  "  (both sides can be kept, a rename, an import, formatting, a lock file to regenerate).",
  '- "skip": resolving it needs a decision about behavior (two behaviors that exclude each other, a feature',
  "  that has to go), it is superseded or duplicated by another PR here, it depends on a PR that is skipped",
  "  or not in this ship and still open, or it is clearly unfinished (WIP, TODO left, empty).",
  "Only open PRs are in the input. A PR that is not in it may be merged already: its changes are on the",
  "default branch (the simulation starts there). Depending on such a PR is no reason to skip.",
  "Be strict with skip: a skipped PR waits for the owner. Do not skip for conflicts a helper can merge.",
  "",
  'When a PR uses what another PR here adds (a function, a file, a setting), give that PR in "after", so it',
  "lands first. Not for PRs that only touch the same files: the order is found by merging.",
  "",
  'Answer with JSON only: {"verdicts": [{"pr": <number>, "action": "ship" | "fix" | "skip", "reason": "<one sentence>", "after": [<numbers>]}]}',
  'with one verdict for every PR in the input; "after" may be left out.',
].join("\n");

function parseVerdict(item: Record<string, unknown>): Verdict | Error {
  if (typeof item.pr !== "number" || !["ship", "fix", "skip"].includes(item.action as string)) {
    return new Error("every verdict needs pr (a number) and action (ship, fix or skip)");
  }
  const after = Array.isArray(item.after)
    ? (item.after as unknown[]).filter((n): n is number => typeof n === "number")
    : [];
  return {
    pr: item.pr,
    action: item.action as Action,
    reason: typeof item.reason === "string" ? item.reason : "",
    ...(after.length > 0 ? { after } : {}),
  };
}

export function parseVerdicts(numbers: readonly number[]) {
  return (value: unknown): Verdict[] | Error => {
    const list = (value as { verdicts?: unknown })?.verdicts;
    if (!Array.isArray(list)) return new Error('expected {"verdicts": [...]}');
    const verdicts: Verdict[] = [];
    for (const item of list as Record<string, unknown>[]) {
      const verdict = parseVerdict(item);
      if (verdict instanceof Error) return verdict;
      verdicts.push(verdict);
    }
    const missing = numbers.filter((n) => !verdicts.some((v) => v.pr === n));
    return missing.length > 0 ? new Error(`no verdict for ${missing.map((n) => `#${n}`).join(", ")}`) : verdicts;
  };
}

/** The input for the agent: each PR with its simulation. */
export function preflightInput(
  repo: string,
  prs: { number: number; title: string; body?: string; note?: string }[],
  simulated: Simulated[] | string,
): string {
  const parts = [`Repository: ${repo}`];
  if (typeof simulated === "string") parts.push(`No simulation (${simulated}); decide from the PRs.`);
  parts.push(...prs.map((pr) => preflightPrInput(pr, simulated)));
  return parts.join("\n\n");
}

function preflightPrInput(
  pr: { number: number; title: string; body?: string; note?: string },
  simulated: Simulated[] | string,
): string {
  const sim = typeof simulated === "string" ? undefined : simulated.find((item) => item.number === pr.number);
  return [
    `## #${pr.number} ${pr.title}`,
    pr.note ? `State: ${pr.note}` : "State: green and mergeable",
    sim ? `Files: ${sim.files.join(", ")}` : "",
    simulationDescription(sim),
    pr.body ? `Body:\n${clipEnd(pr.body, 1500)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function simulationDescription(sim?: Simulated): string {
  if (!sim) return "";
  if (sim.clean) return "Simulation: clean";
  const against =
    sim.against.length > 0 ? ` (with ${sim.against.map((n) => `#${n}`).join(", ")})` : " (with the default branch)";
  return `Simulation: conflicts in ${sim.conflicts.join(", ")}${against}\n${sim.markers}`;
}
