import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Whether agents may take a step. */
export type Lock = "locked" | "unlocked";

/** The steps that change a repository, each locked on its own. */
export const STEPS = ["worktree", "commit", "push", "pr"] as const;
export type Step = (typeof STEPS)[number];

/** The state per step; a step that is missing follows the next level (global, then the default). */
export type Setting = Partial<Record<Step, Lock>>;

/** The switch: global settings and overrides per repository (owner/name). */
export interface Switch {
  global: Setting;
  repos: Record<string, Setting>;
}

export const SWITCH_FILE = "switch.json";

export function switchPath(stateDir: string): string {
  return join(stateDir, SWITCH_FILE);
}

function isLock(value: unknown): value is Lock {
  return value === "locked" || value === "unlocked";
}

export function isStep(value: unknown): value is Step {
  return (STEPS as readonly unknown[]).includes(value);
}

/** A setting from the file: `"unlocked"` means every step, an object sets single steps. */
function toSetting(raw: unknown): Setting {
  if (isLock(raw)) return Object.fromEntries(STEPS.map((step) => [step, raw])) as Setting;
  const setting: Setting = {};
  if (typeof raw === "object" && raw !== null) {
    for (const [step, lock] of Object.entries(raw)) if (isStep(step) && isLock(lock)) setting[step] = lock;
  }
  return setting;
}

/** Read the switch; a missing or broken file has no settings, so the default applies. */
export function loadSwitch(stateDir: string): Switch {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(switchPath(stateDir), "utf8"));
  } catch {
    return { global: {}, repos: {} };
  }
  const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const repos: Record<string, Setting> = {};
  if (typeof record.repos === "object" && record.repos !== null) {
    for (const [slug, setting] of Object.entries(record.repos)) {
      const parsed = toSetting(setting);
      if (Object.keys(parsed).length > 0) repos[slug] = parsed;
    }
  }
  return { global: toSetting(record.global), repos };
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

/** The state of a step in a repository: its override, else the global setting, else the default. */
export function effective(value: Switch, slug: string | undefined, step: Step, fallback: Lock): Effective {
  const key = slug === undefined ? undefined : repoKey(value, slug);
  const repo = key === undefined ? undefined : value.repos[key]?.[step];
  if (repo !== undefined) return { lock: repo, source: "repo" };
  const global = value.global[step];
  if (global !== undefined) return { lock: global, source: "global" };
  return { lock: fallback, source: "default" };
}

/** Change steps (all when empty) of a setting; undefined removes them, so they follow the next level. */
function change(setting: Setting, steps: readonly Step[], lock: Lock | undefined): Setting {
  const next: Setting = { ...setting };
  for (const step of steps.length > 0 ? steps : STEPS) {
    if (lock === undefined) delete next[step];
    else next[step] = lock;
  }
  return next;
}

/** Set steps of a repository; with undefined they follow the global setting again. */
export function setRepo(stateDir: string, slug: string, steps: readonly Step[], lock: Lock | undefined): void {
  const value = loadSwitch(stateDir);
  const key = repoKey(value, slug);
  const setting = change(key === undefined ? {} : (value.repos[key] as Setting), steps, lock);
  if (key !== undefined) delete value.repos[key];
  if (Object.keys(setting).length > 0) value.repos[slug] = setting;
  saveSwitch(stateDir, value);
}

/** Set global steps; with undefined they follow the default again. */
export function setGlobal(stateDir: string, steps: readonly Step[], lock: Lock | undefined): void {
  const value = loadSwitch(stateDir);
  saveSwitch(stateDir, { ...value, global: change(value.global, steps, lock) });
}
