import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Whether agents may change git repositories. */
export type Lock = "locked" | "unlocked";

/** The switch: a global state and overrides per repository (owner/name). */
export interface Switch {
  global?: Lock;
  repos: Record<string, Lock>;
}

export const SWITCH_FILE = "switch.json";

export function switchPath(stateDir: string): string {
  return join(stateDir, SWITCH_FILE);
}

function isLock(value: unknown): value is Lock {
  return value === "locked" || value === "unlocked";
}

/** Read the switch; a missing or broken file has no settings, so the default applies. */
export function loadSwitch(stateDir: string): Switch {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(switchPath(stateDir), "utf8"));
  } catch {
    return { repos: {} };
  }
  const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const repos: Record<string, Lock> = {};
  if (typeof record.repos === "object" && record.repos !== null) {
    for (const [slug, lock] of Object.entries(record.repos)) if (isLock(lock)) repos[slug] = lock;
  }
  return isLock(record.global) ? { global: record.global, repos } : { repos };
}

function saveSwitch(stateDir: string, value: Switch): void {
  mkdirSync(stateDir, { recursive: true });
  const path = switchPath(stateDir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

function repoKey(value: Switch, slug: string): string | undefined {
  return Object.keys(value.repos).find((key) => key.toLowerCase() === slug.toLowerCase());
}

export interface Effective {
  lock: Lock;
  /** Where the state comes from. */
  source: "repo" | "global" | "default";
}

/** The state for a repository: its override, else the global state, else the default. */
export function effective(value: Switch, slug: string | undefined, fallback: Lock): Effective {
  const key = slug === undefined ? undefined : repoKey(value, slug);
  if (key !== undefined) return { lock: value.repos[key] as Lock, source: "repo" };
  if (value.global !== undefined) return { lock: value.global, source: "global" };
  return { lock: fallback, source: "default" };
}

/** Set (or with undefined: remove) the override of a repository. */
export function setRepo(stateDir: string, slug: string, lock: Lock | undefined): void {
  const value = loadSwitch(stateDir);
  const key = repoKey(value, slug);
  if (key !== undefined) delete value.repos[key];
  if (lock !== undefined) value.repos[slug] = lock;
  saveSwitch(stateDir, value);
}

/** Set (or with undefined: remove) the global state. */
export function setGlobal(stateDir: string, lock: Lock | undefined): void {
  const { repos } = loadSwitch(stateDir);
  saveSwitch(stateDir, lock === undefined ? { repos } : { global: lock, repos });
}
