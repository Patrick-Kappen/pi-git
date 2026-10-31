import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** The final states of a watched PR; the watcher reports each to the main agent once. */
export type FinalStatus = "merged" | "closed" | "failed";
export type Status = "watching" | "green" | FinalStatus;

/** A PR the watcher follows: written by git_pr, updated by the watcher. */
export interface Entry {
  id: string;
  /** owner/name */
  repo: string;
  number: number;
  url: string;
  worktree: string;
  /** The main checkout, for removing the worktree after the merge. */
  mainRoot: string;
  branch: string;
  base: string;
  intent: string;
  /** The pi session that ran git_pr; its summary goes there first. */
  sessionId: string;
  status: Status;
  /** Fixes the helper made (CI or conflicts); limited by \`attempts\`. */
  attempts: number;
  /** The head the helper last tried to fix, so one red head is fixed once. */
  fixedSha?: string;
  /** The head that was reported green. */
  greenSha?: string;
  /** The head that was reported as waiting for an unlock. */
  lockedSha?: string;
  /** Polls in a row where gh failed. */
  errors: number;
  /** What the helper did. */
  notes: string[];
  updated: string;
}

/** A summary for the main agent. */
export interface Summary {
  id: string;
  entryId: string;
  repo: string;
  number: number;
  sessionId: string;
  status: Status;
  text: string;
  created: string;
}

export const dirs = (stateDir: string) => ({
  prs: join(stateDir, "prs"),
  inbox: join(stateDir, "inbox"),
  delivered: join(stateDir, "delivered"),
  sessions: join(stateDir, "sessions"),
  locks: join(stateDir, "locks"),
});

/** A file name for a PR: \`owner/name#12\` is \`owner__name__12\`. */
export function entryId(repo: string, number: number): string {
  return `${repo.replace(/[^A-Za-z0-9._-]/g, "__")}__${number}`;
}

/** Write JSON atomically: to a temporary file, then rename. */
function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
}

export function saveEntry(stateDir: string, entry: Entry): void {
  const { prs } = dirs(stateDir);
  mkdirSync(prs, { recursive: true });
  writeJson(join(prs, `${entry.id}.json`), entry);
}

export function loadEntries(stateDir: string): Entry[] {
  const { prs } = dirs(stateDir);
  return list(prs)
    .map((name) => readJson<Entry>(join(prs, name)))
    .filter((entry): entry is Entry => entry !== undefined);
}

export function removeEntry(stateDir: string, id: string): void {
  rmSync(join(dirs(stateDir).prs, `${id}.json`), { force: true });
}

export function addSummary(stateDir: string, summary: Omit<Summary, "id">): Summary {
  const { inbox } = dirs(stateDir);
  mkdirSync(inbox, { recursive: true });
  const full = { ...summary, id: `${summary.created.replace(/[^0-9]/g, "")}-${summary.entryId}` };
  writeJson(join(inbox, `${full.id}.json`), full);
  return full;
}

export function loadSummaries(stateDir: string): Summary[] {
  const { inbox } = dirs(stateDir);
  return list(inbox)
    .map((name) => readJson<Summary>(join(inbox, name)))
    .filter((summary): summary is Summary => summary !== undefined);
}

/** Take a summary out of the inbox. Only one session wins; the others get false. */
export function claimSummary(stateDir: string, id: string): boolean {
  const { inbox, delivered } = dirs(stateDir);
  mkdirSync(delivered, { recursive: true });
  try {
    renameSync(join(inbox, `${id}.json`), join(delivered, `${id}.json`));
    return true;
  } catch {
    return false;
  }
}

/** Mark a session as running. */
export function heartbeat(stateDir: string, sessionId: string, now = new Date()): void {
  const { sessions } = dirs(stateDir);
  mkdirSync(sessions, { recursive: true });
  const path = join(sessions, sessionId);
  writeFileSync(path, "");
  utimesSync(path, now, now);
}

export function endSession(stateDir: string, sessionId: string): void {
  rmSync(join(dirs(stateDir).sessions, sessionId), { force: true });
}

/** Whether a session sent a heartbeat within \`maxAgeMs\`. */
export function sessionAlive(stateDir: string, sessionId: string, maxAgeMs: number, now = Date.now()): boolean {
  try {
    return now - statSync(join(dirs(stateDir).sessions, sessionId)).mtimeMs <= maxAgeMs;
  } catch {
    return false;
  }
}

/** Take a lock file; undefined when another process holds it. Stale locks (older than \`maxAgeMs\`) are taken over. */
export function lock(stateDir: string, name: string, maxAgeMs: number, now = Date.now()): (() => void) | undefined {
  const { locks } = dirs(stateDir);
  mkdirSync(locks, { recursive: true });
  const path = join(locks, name);
  try {
    closeSync(openSync(path, "wx"));
  } catch {
    try {
      if (now - statSync(path).mtimeMs <= maxAgeMs) return undefined;
    } catch {
      return undefined;
    }
    writeFileSync(path, "");
  }
  return () => rmSync(path, { force: true });
}
