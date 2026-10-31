import type { Runner } from "./exec.ts";
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

/**
 * Merge the PRs locally in order (oldest first). A clean PR becomes part of the base for the next
 * ones; a conflicting one does not (the ship fixes it on its own). A string is why it could not run.
 */
export async function simulate(
  run: Runner,
  main: string,
  base: string,
  items: readonly { number: number; onto?: number | undefined }[],
): Promise<Simulated[] | string> {
  const git = (...args: string[]) => run("git", args, { cwd: main, env: IDENTITY });
  const refs = items.map(({ number }) => `+pull/${number}/head:refs/pi-git/ship/${number}`);
  const fetched = await git("fetch", "origin", base, ...refs);
  if (fetched.code !== 0) return `git fetch failed: ${clipEnd(outputOf(fetched), 300)}`;
  let current = (await git("rev-parse", `origin/${base}`)).stdout.trim();
  const start = current;
  const touched = new Map<number, string[]>();
  const result: Simulated[] = [];
  for (const { number, onto } of items) {
    const head = `refs/pi-git/ship/${number}`;
    // A stacked PR: only its own commits, those after the head of the PR it builds on.
    const from = onto === undefined ? start : `refs/pi-git/ship/${onto}`;
    const files = (await git("diff", "--name-only", `${from}...${head}`)).stdout.split("\n").filter(Boolean);
    touched.set(number, files);
    const mergeBase = onto === undefined ? [] : [`--merge-base=${from}`];
    const merged = await git("merge-tree", "--write-tree", "--name-only", "--no-messages", ...mergeBase, current, head);
    const [tree = "", ...rest] = merged.stdout.trim().split("\n");
    if (merged.code === 0) {
      const commit = await git("commit-tree", tree, "-p", current, "-p", head, "-m", `ship: #${number}`);
      if (commit.code === 0) current = commit.stdout.trim();
      result.push({ number, clean: true, files, conflicts: [], against: [], markers: "" });
      continue;
    }
    const conflicts = rest.filter(Boolean);
    const against = [...touched.entries()]
      .filter(([other, changed]) => other !== number && changed.some((file) => conflicts.includes(file)))
      .map(([other]) => other)
      .filter((other) => result.find((item) => item.number === other)?.clean);
    const parts: string[] = [];
    for (const file of conflicts.slice(0, 5)) {
      const shown = await git("show", `${tree}:${file}`);
      parts.push(`--- ${file}\n${clipEnd(conflictRegions(shown.stdout), MARKERS_PER_FILE)}`);
    }
    result.push({ number, clean: false, files, conflicts, against, markers: parts.join("\n") });
  }
  return result;
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
}

export const PREFLIGHT_PROMPT = [
  "You check the open PRs of one repository before pi-git /ship merges them, oldest first. The input has",
  "every PR (title, body, changed files, the state of its checks) and a local simulation: each PR merged in",
  "order onto the default branch and onto the earlier clean PRs, with the conflicting files and markers.",
  "",
  "Decide per PR:",
  '- "ship": it merges cleanly, or its checks only still run.',
  '- "fix": it conflicts or its checks fail, and a helper can resolve that without changing behavior',
  "  (both sides can be kept, a rename, an import, formatting, a lock file to regenerate).",
  '- "skip": resolving it needs a decision about behavior (two behaviors that exclude each other, a feature',
  "  that has to go), it is superseded or duplicated by another PR here, it depends on a PR that is skipped",
  "  or not in this ship, or it is clearly unfinished (WIP, TODO left, empty).",
  "Be strict with skip: a skipped PR waits for the owner. Do not skip for conflicts a helper can merge.",
  "",
  'Answer with JSON only: {"verdicts": [{"pr": <number>, "action": "ship" | "fix" | "skip", "reason": "<one sentence>"}]}',
  "with one verdict for every PR in the input.",
].join("\n");

export function parseVerdicts(numbers: readonly number[]) {
  return (value: unknown): Verdict[] | Error => {
    const list = (value as { verdicts?: unknown })?.verdicts;
    if (!Array.isArray(list)) return new Error('expected {"verdicts": [...]}');
    const verdicts: Verdict[] = [];
    for (const item of list as Record<string, unknown>[]) {
      if (typeof item.pr !== "number" || !["ship", "fix", "skip"].includes(item.action as string)) {
        return new Error("every verdict needs pr (a number) and action (ship, fix or skip)");
      }
      verdicts.push({
        pr: item.pr,
        action: item.action as Action,
        reason: typeof item.reason === "string" ? item.reason : "",
      });
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
