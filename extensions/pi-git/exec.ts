import { spawn } from "node:child_process";

export interface RunResult {
  /** The exit code; null when the command could not start, timed out or was aborted. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Why the command did not finish normally. */
  failure?: string;
}

export interface RunOptions {
  cwd: string;
  /** Added to the environment of this process. */
  env?: Record<string, string>;
  /** Written to stdin. */
  input?: string;
  timeoutMs?: number;
  signal?: AbortSignal | undefined;
}

/** Runs a command; tests pass a fake. */
export type Runner = (command: string, args: readonly string[], options: RunOptions) => Promise<RunResult>;

/** Run a command without a shell and collect its output. */
export const run: Runner = (command, args, options) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let failure: string | undefined;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            failure = `timed out after ${Math.round((options.timeoutMs as number) / 1000)}s`;
            child.kill("SIGKILL");
          }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      failure ??= error.name === "AbortError" ? "aborted" : error.message;
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: failure ? null : code, stdout, stderr, ...(failure ? { failure } : {}) });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
  });

/** stdout and stderr together, and why the command failed to finish. */
export function outputOf(result: RunResult): string {
  return [result.stdout.trim(), result.stderr.trim(), result.failure ? `(${result.failure})` : ""]
    .filter((part) => part !== "")
    .join("\n");
}

/** Text cut to `max` characters, keeping the end, where errors usually are. */
export function clipEnd(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `[... ${trimmed.length - max} characters cut]\n${trimmed.slice(-max)}`;
}

/** Text cut to `max` characters, keeping the start. */
export function clipStart(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}\n[... ${trimmed.length - max} characters cut]`;
}
