import type { Config } from "./config.ts";
import { clipEnd, outputOf, type Runner } from "./exec.ts";
import { extractJson } from "./json.ts";

/** Set for helper processes: the extension then only guards, and registers no tools. */
export const HELPER_ENV = "PI_GIT_HELPER";
/** The tools of a helper that changes files; one that only answers can read the skill's references. */
export const FIX_TOOLS = "read,bash,edit,write,grep,find,ls";
export const ANSWER_TOOLS = "read";

export interface HelperTask {
  cwd: string;
  /** The instructions; `/skill:git` is put in front. */
  prompt: string;
  /** Data for the task, on stdin. */
  input: string;
  /** Whether the helper may change files. */
  fix: boolean;
  signal?: AbortSignal | undefined;
}

export interface HelperResult {
  ok: boolean;
  /** The helper's final answer. */
  text: string;
  failure?: string;
}

export function helperArgs(config: Config, task: HelperTask): string[] {
  return [
    "-p",
    "--no-session",
    "--model",
    config.model,
    "--thinking",
    config.thinking,
    ...(config.skill ? ["--skill", config.skill] : []),
    // An answer needs no extensions; a fix keeps them, so permissions, hooks and the guard apply.
    ...(task.fix ? ["--tools", FIX_TOOLS] : ["--tools", ANSWER_TOOLS, "--no-extensions"]),
    `${config.skill ? "/skill:git " : ""}${task.prompt}`,
  ];
}

/** Run the helper agent: `pi -p` with the cheap model, in the worktree. */
export async function runHelper(run: Runner, config: Config, task: HelperTask): Promise<HelperResult> {
  const result = await run(config.pi, helperArgs(config, task), {
    cwd: task.cwd,
    input: task.input,
    env: { [HELPER_ENV]: task.fix ? "fix" : "answer" },
    timeoutMs: config.helperTimeout * 1000,
    signal: task.signal,
  });
  if (result.code !== 0) {
    return { ok: false, text: result.stdout.trim(), failure: `the helper failed: ${clipEnd(outputOf(result), 2000)}` };
  }
  return { ok: true, text: result.stdout.trim() };
}

/** Ask the helper for a JSON answer; an unusable answer is asked again once. */
export async function askJson<T>(
  run: Runner,
  config: Config,
  task: Omit<HelperTask, "fix">,
  parse: (value: unknown) => T | Error,
  attempts = 2,
): Promise<T | Error> {
  let prompt = task.prompt;
  let problem = new Error("no answer");
  for (let attempt = 0; attempt < attempts; attempt++) {
    const answer = await runHelper(run, config, { ...task, prompt, fix: false });
    if (!answer.ok) return new Error(answer.failure);
    try {
      const parsed = parse(extractJson(answer.text));
      if (!(parsed instanceof Error)) return parsed;
      problem = parsed;
    } catch (error) {
      problem = error as Error;
    }
    prompt = `${task.prompt}\n\nYour previous answer could not be used (${problem.message}). Reply with the JSON object only.`;
  }
  return problem;
}
