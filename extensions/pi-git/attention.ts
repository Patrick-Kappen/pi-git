import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Runner } from "./exec.ts";
import type { Step } from "./switch.ts";

/** Why the user is needed: a blocked step, a request of the agent, or a PR the watcher cannot finish. */
export type AttentionKind = "blocked" | "request" | "watcher";

export interface Attention {
  id: string;
  kind: AttentionKind;
  /** owner/name, when it is about a repository. */
  repo?: string;
  step?: Step;
  text: string;
  created: string;
}

export function attentionDir(stateDir: string): string {
  return join(stateDir, "attention");
}

/** The file name for an item: one per kind, repository and step (or PR), so a repeat does not pile up. */
export function attentionId(kind: AttentionKind, repo: string | undefined, detail: string | undefined): string {
  return [kind, repo ?? "none", detail ?? "any"].join("__").replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Add an item, or update its text; `fresh` says whether it is new, so the user is notified once.
 * One item per kind, repository and `detail` (default: the step).
 */
export function addAttention(
  stateDir: string,
  item: Omit<Attention, "id" | "created">,
  detail: string | undefined = item.step,
  now = new Date(),
): { item: Attention; fresh: boolean } {
  const dir = attentionDir(stateDir);
  mkdirSync(dir, { recursive: true });
  const id = attentionId(item.kind, item.repo, detail);
  const path = join(dir, `${id}.json`);
  let previous: Attention | undefined;
  try {
    previous = JSON.parse(readFileSync(path, "utf8")) as Attention;
  } catch {
    previous = undefined;
  }
  const full: Attention = { ...item, id, created: previous?.created ?? now.toISOString() };
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(full, null, 2)}\n`);
  renameSync(tmp, path);
  return { item: full, fresh: previous === undefined };
}

export function listAttention(stateDir: string): Attention[] {
  const dir = attentionDir(stateDir);
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
  const items: Attention[] = [];
  for (const name of names) {
    try {
      items.push(JSON.parse(readFileSync(join(dir, name), "utf8")) as Attention);
    } catch {
      // A file that is being written, or broken: skip it.
    }
  }
  return items.sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
}

/** Remove the items that match; returns how many. */
export function clearAttention(stateDir: string, match: (item: Attention) => boolean): number {
  let count = 0;
  for (const item of listAttention(stateDir)) {
    if (!match(item)) continue;
    rmSync(join(attentionDir(stateDir), `${item.id}.json`), { force: true });
    count++;
  }
  return count;
}

/** A terminal notification (OSC 777, shown by WezTerm and others) without characters that break it. */
export function osc777(title: string, body: string): string {
  const clean = (text: string) =>
    [...text]
      .map((char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === ";" ? " " : char))
      .join("")
      .slice(0, 300);
  return `\x1b]777;notify;${clean(title)};${clean(body)}\x07`;
}

/**
 * Tell the user: a notification on the terminal of every tmux client (written to the client's tty,
 * so it needs no passthrough and works from the watcher too), and a refresh of their status line.
 * Returns how many terminals got it. `PI_GIT_NO_NOTIFY` turns it off.
 */
export async function notifyTerminals(
  run: Runner,
  title: string,
  body: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  if (env.PI_GIT_NO_NOTIFY) return 0;
  const clients = await run("tmux", ["list-clients", "-F", "#{client_tty}"], { cwd: "/" });
  if (clients.code !== 0) return 0;
  let count = 0;
  for (const tty of clients.stdout.split("\n").filter((line) => line.startsWith("/"))) {
    try {
      appendFileSync(tty, osc777(title, body));
      count++;
    } catch {
      // A client that went away, or a terminal that is not ours.
    }
    await run("tmux", ["refresh-client", "-S", "-t", tty], { cwd: "/" });
  }
  return count;
}
