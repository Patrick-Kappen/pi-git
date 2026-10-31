import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { clipEnd, outputOf, type Runner } from "./exec.ts";
import { runHelper } from "./helper.ts";
import { checkFixPrompt, summaryPrompt } from "./prompts.ts";

export interface CheckInput {
  /** A directory in the repository. */
  path: string;
  /** The command to run with `sh -c`; default: detected from the repository. */
  command?: string;
  /** Let the helper fix failures; default: true. */
  fix?: boolean;
}

export interface CheckResult {
  ok: boolean;
  summary: string;
  command?: string;
  notes: string[];
}

export interface CheckDeps {
  run: Runner;
  config: Config;
  progress: (text: string) => void;
  signal?: AbortSignal | undefined;
}

function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** The check command of a repository: its devenv `check`, `npm test`, `nix flake check`, or make. */
export function detectCommand(root: string): string | undefined {
  if (/\bcheck(\.exec|\s*=)/.test(read(join(root, "devenv.nix")))) return "devenv shell -- check";
  try {
    const scripts =
      (JSON.parse(read(join(root, "package.json"))) as { scripts?: Record<string, string> }).scripts ?? {};
    if (scripts.check) return "npm run check";
    if (scripts.test) return "npm test";
  } catch {
    // No package.json, or not JSON.
  }
  if (existsSync(join(root, "flake.nix"))) return "nix flake check";
  const makefile = read(join(root, "Makefile"));
  if (/^check:/m.test(makefile)) return "make check";
  if (/^test:/m.test(makefile)) return "make test";
  return undefined;
}

function listed(title: string, notes: readonly string[]): string {
  return notes.length > 0 ? `\n${title}\n${notes.map((note) => `- ${note}`).join("\n")}` : "";
}

/** A red result: the helper summarizes the output for the main agent. */
async function red(
  deps: CheckDeps,
  root: string,
  command: string,
  output: string,
  notes: string[],
): Promise<CheckResult> {
  deps.progress("the helper summarizes the failures");
  const summary = await runHelper(deps.run, deps.config, {
    cwd: root,
    prompt: summaryPrompt(command),
    input: output,
    fix: false,
    signal: deps.signal,
  });
  const text = summary.ok && summary.text !== "" ? summary.text : clipEnd(output, 4000);
  return {
    ok: false,
    summary: `Checks fail: \`${command}\`\n${text}${listed("The helper tried:", notes)}`,
    command,
    notes,
  };
}

/** Let the helper fix the failure; a result means it could not. */
async function helperFix(
  deps: CheckDeps,
  root: string,
  command: string,
  output: string,
  attempt: number,
  notes: string[],
): Promise<CheckResult | undefined> {
  deps.progress(`checks fail; the helper fixes them (attempt ${attempt}/${deps.config.attempts})`);
  const helper = await runHelper(deps.run, deps.config, {
    cwd: root,
    prompt: checkFixPrompt(command, attempt, deps.config.attempts),
    input: `Output of \`${command}\`:\n${output}\n`,
    fix: true,
    signal: deps.signal,
  });
  if (!helper.ok) return { ok: false, summary: `Checks fail: \`${command}\`, and ${helper.failure}`, command, notes };
  notes.push(helper.text.split("\n")[0]?.slice(0, 300) ?? "");
  if (/^CANNOT FIX:/m.test(helper.text)) {
    return {
      ok: false,
      summary: `Checks fail: \`${command}\`\n${helper.text}\n\n${clipEnd(output, 4000)}`,
      command,
      notes,
    };
  }
  return undefined;
}

/** Run the checks of a repository; while they fail, the helper fixes them. Red results are summarized. */
export async function gitCheck(input: CheckInput, deps: CheckDeps): Promise<CheckResult> {
  const { run, config, progress, signal } = deps;
  const top = await run("git", ["rev-parse", "--show-toplevel"], { cwd: input.path });
  if (top.code !== 0) return { ok: false, summary: `git_check: ${input.path} is not in a git repository`, notes: [] };
  const root = top.stdout.trim();
  const command = input.command ?? detectCommand(root);
  if (!command)
    return { ok: false, summary: `git_check: no check command found in ${root}; pass "command".`, notes: [] };
  const notes: string[] = [];
  for (let attempt = 1; ; attempt++) {
    progress(`running ${command}`);
    const started = Date.now();
    const result = await run("sh", ["-c", command], { cwd: root, timeoutMs: config.checkTimeout * 1000, signal });
    if (result.code === 0) {
      const seconds = Math.round((Date.now() - started) / 1000);
      return {
        ok: true,
        summary: `Checks passed: \`${command}\` (${seconds}s).${listed("The helper fixed:", notes)}`,
        command,
        notes,
      };
    }
    const output = clipEnd(outputOf(result), 20_000);
    if (input.fix === false || attempt > config.attempts || result.failure === "aborted")
      return red(deps, root, command, output, notes);
    const stopped = await helperFix(deps, root, command, output, attempt, notes);
    if (stopped) return stopped;
  }
}
