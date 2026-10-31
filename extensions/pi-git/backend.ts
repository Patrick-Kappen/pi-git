import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { matchingPatterns } from "./switch.ts";

/**
 * How git_start makes a new worktree: a git worktree (the default), or a colocated jj workspace.
 * A worktree that exists follows what it is, whatever the setting says now.
 */
export type Backend = "git" | "jj";
export const BACKENDS: readonly Backend[] = ["git", "jj"];

/** /git backend per repository (owner/name); apart from the locks in switch.json. */
export const BACKENDS_FILE = "backends.json";

export function isBackend(value: unknown): value is Backend {
  return (BACKENDS as readonly unknown[]).includes(value);
}

function backendsPath(stateDir: string): string {
  return join(stateDir, BACKENDS_FILE);
}

/** The backends set with /git backend; a missing or broken file sets none. */
export function loadBackends(stateDir: string): Record<string, Backend> {
  try {
    const raw = JSON.parse(readFileSync(backendsPath(stateDir), "utf8")) as unknown;
    return toBackends(raw);
  } catch {
    return {};
  }
}

/** The valid entries of a pattern (or owner/name) to backend object. */
export function toBackends(raw: unknown): Record<string, Backend> {
  const result: Record<string, Backend> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return result;
  for (const [key, value] of Object.entries(raw)) if (key.trim() !== "" && isBackend(value)) result[key] = value;
  return result;
}

/** Set the backend of a repository; undefined lets it follow the config again. */
export function setBackend(stateDir: string, slug: string, backend: Backend | undefined): void {
  const value = loadBackends(stateDir);
  for (const key of Object.keys(value)) if (key.toLowerCase() === slug.toLowerCase()) delete value[key];
  if (backend) value[slug] = backend;
  mkdirSync(stateDir, { recursive: true });
  const path = backendsPath(stateDir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

export interface ChosenBackend {
  backend: Backend;
  /** /git backend for the repository, a pattern of `backends` in the config, or `backend` of the config. */
  source: "repo" | "settings" | "default";
  pattern?: string;
}

/** The backend of a repository: /git backend, else the most specific pattern of `backends`, else `backend`. */
export function backendOf(
  stateDir: string,
  slug: string | undefined,
  settings: Record<string, Backend>,
  fallback: Backend,
): ChosenBackend {
  if (slug === undefined) return { backend: fallback, source: "default" };
  const own = Object.entries(loadBackends(stateDir)).find(([key]) => key.toLowerCase() === slug.toLowerCase());
  if (own) return { backend: own[1], source: "repo" };
  const [pattern] = matchingPatterns(settings, slug);
  if (pattern !== undefined) return { backend: settings[pattern] as Backend, source: "settings", pattern };
  return { backend: fallback, source: "default" };
}

/** For /git: which backend new worktrees of the repository get, and why. */
export function describeBackend(chosen: ChosenBackend): string {
  const why =
    chosen.source === "repo"
      ? "/git backend"
      : chosen.source === "settings"
        ? `"backends" in the config (${chosen.pattern})`
        : '"backend" in the config';
  return `new worktrees: ${chosen.backend} (${why}); /git backend git|jj|reset`;
}
