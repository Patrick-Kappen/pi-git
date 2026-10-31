import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const CONFIG_FILE = "pi-git.json";

/** How a summary from the watcher reaches the main agent. */
export type Delivery = "turn" | "message" | "notify";
export const DELIVERIES: readonly Delivery[] = ["turn", "message", "notify"];

export interface Config {
  path: string;
  /** The helper's model, as `pi --model` takes it. */
  model: string;
  /** The helper's thinking level. */
  thinking: string;
  /** The git skill directory, passed to the helper with `--skill`. */
  skill: string | undefined;
  /** The pi command for the helper. */
  pi: string;
  /** How often the helper may try to fix one failing step. */
  attempts: number;
  /** Seconds for one hook or check run (the pre-push hook runs all checks). */
  checkTimeout: number;
  /** Seconds for one helper run. */
  helperTimeout: number;
  /** Where worktrees go: `<worktrees>/<repo>/<topic>`. */
  worktrees: string;
  /** State of the watcher: queued PRs and summaries. */
  stateDir: string;
  delivery: Delivery;
  /** Whether git changes by agents are locked where the switch says nothing (/git). */
  locked: boolean;
  errors: string[];
}

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return resolve(path);
}

/** pi's agent directory: `$PI_CODING_AGENT_DIR` or `~/.pi/agent`. */
export function agentDir(env: NodeJS.ProcessEnv, home: string): string {
  const dir = env.PI_CODING_AGENT_DIR;
  return dir ? expandHome(dir, home) : join(home, ".pi", "agent");
}

/** `$PI_GIT_CONFIG`, else `pi-git.json` in the agent directory. */
export function configPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const file = env.PI_GIT_CONFIG;
  return file ? expandHome(file, home) : join(agentDir(env, home), CONFIG_FILE);
}

export function defaults(path: string, env: NodeJS.ProcessEnv, home: string): Config {
  const state = env.XDG_STATE_HOME ? expandHome(env.XDG_STATE_HOME, home) : join(home, ".local", "state");
  return {
    path,
    model: "openai-codex/gpt-6-luna",
    thinking: "xhigh",
    skill: undefined,
    pi: "pi",
    attempts: 3,
    checkTimeout: 1800,
    helperTimeout: 900,
    worktrees: join(home, ".worktrees"),
    stateDir: join(state, "pi-git"),
    delivery: "turn",
    locked: true,
    errors: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Field = "model" | "thinking" | "skill" | "pi" | "worktrees" | "stateDir";
const STRINGS: readonly Field[] = ["model", "thinking", "skill", "pi", "worktrees", "stateDir"];
const PATHS: ReadonlySet<Field> = new Set(["skill", "worktrees", "stateDir"]);
const NUMBERS = ["attempts", "checkTimeout", "helperTimeout"] as const;

/** Apply `locked` or `delivery`; a string is the error. */
function applyChoice(config: Config, key: string, value: unknown): string | undefined {
  if (key === "locked") {
    if (typeof value !== "boolean") return '"locked" must be true or false';
    config.locked = value;
  } else if (key === "delivery") {
    if (!(DELIVERIES as readonly unknown[]).includes(value))
      return `"delivery" must be one of ${DELIVERIES.join(", ")}`;
    config.delivery = value as Delivery;
  } else {
    return `unknown key "${key}"`;
  }
  return undefined;
}

/** Apply one setting; a string is the error. */
function applyField(config: Config, key: string, value: unknown, home: string): string | undefined {
  if ((STRINGS as readonly string[]).includes(key)) {
    if (typeof value !== "string" || value.trim() === "") return `"${key}" must be a string`;
    config[key as Field] = PATHS.has(key as Field) ? expandHome(value, home) : value;
  } else if ((NUMBERS as readonly string[]).includes(key)) {
    if (typeof value !== "number" || !(value > 0)) return `"${key}" must be a positive number`;
    config[key as (typeof NUMBERS)[number]] = value;
  } else {
    return applyChoice(config, key, value);
  }
  return undefined;
}

/** Apply the settings of the config file to the defaults; problems go to `errors`. */
export function parseConfig(raw: unknown, base: Config, home: string): Config {
  const config: Config = { ...base, errors: [] };
  if (!isRecord(raw)) {
    config.errors.push(`${base.path}: expected a JSON object`);
    return config;
  }
  for (const [key, value] of Object.entries(raw)) {
    const error = applyField(config, key, value, home);
    if (error) config.errors.push(`${base.path}: ${error}`);
  }
  return config;
}

/** Read the config file; a missing file means the defaults. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): Config {
  const path = configPath(env, home);
  const base = defaults(path, env, home);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return base;
    return { ...base, errors: [`${path}: ${(error as Error).message}`] };
  }
  try {
    return parseConfig(JSON.parse(text), base, home);
  } catch (error) {
    return { ...base, errors: [`${path}: invalid JSON: ${(error as Error).message}`] };
  }
}
