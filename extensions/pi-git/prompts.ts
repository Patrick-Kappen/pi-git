/** The instructions for the helper agent. The data of each task goes on stdin. */

export type Stage = "pre-commit" | "commit" | "pre-push";

const STAGE_TEXT: Record<Stage, string> = {
  "pre-commit": "The pre-commit checks fail on the staged changes",
  commit: "The commit was refused by a hook",
  "pre-push": "The pre-push checks fail (they run before the push)",
};

/** Fix a failing check in the worktree. */
export function fixPrompt(stage: Stage, attempt: number, attempts: number): string {
  return [
    `You are the helper of pi-git, attempt ${attempt} of ${attempts}. ${STAGE_TEXT[stage]} in this worktree.`,
    "The input has what the change is for, and the output of the checks.",
    "",
    "Fix the cause in the files, within the intent of the change:",
    "- Run the failing check yourself to see the problem and to confirm your fix.",
    "- Do not stage, commit, push, switch branches, or call gh: pi-git does those steps.",
    "- Never weaken or skip a check, a hook, a test or a threshold.",
    "- Generated files (lock files, files from a generator) are regenerated with their tool, not edited.",
    "",
    "End with one or two sentences on what you changed. When you cannot fix it within the intent,",
    'answer "CANNOT FIX:" and the reason.',
  ].join("\n");
}

/** A commit message as JSON. */
export function messagePrompt(conventional: boolean): string {
  const style = conventional
    ? "This repository uses Conventional Commits: type(scope): subject, see references/commits.md of the git skill."
    : "This repository does not use Conventional Commits: follow the style of the recent subjects in the input.";
  return [
    "You are the helper of pi-git. Write the commit message for the staged change in the input.",
    style,
    "Subject: imperative, at most 72 characters, no period. Body: why the change is needed, wrapped at 72;",
    'empty when the subject says enough. Reply with JSON only: {"subject": "...", "body": "..."}',
  ].join("\n");
}

/** A rejected message: write a new one. */
export function messageRetryPrompt(conventional: boolean, problem: string): string {
  return `${messagePrompt(conventional)}\n\nThe commit-msg hook rejected the previous message:\n${problem}`;
}

/** The title and body of a PR as JSON. */
export function pullRequestPrompt(conventional: boolean, existing: boolean): string {
  return [
    `You are the helper of pi-git. Write the ${existing ? "updated " : ""}title and body of the pull request for the change in the input.`,
    `Title: ${conventional ? "a Conventional Commit" : "in the style of the recent subjects"}, at most 72 characters; with squash merges it becomes the commit.`,
    "Body: follow the template in the input when there is one, else the format of references/pull-requests.md",
    "of the git skill (What, Why, Testing, Notes). Write for a reviewer who did not see the conversation.",
    existing ? "Keep what is still true of the current title and body, and cover the new commits." : "",
    'Reply with JSON only: {"title": "...", "body": "..."}',
  ]
    .filter((line) => line !== "")
    .join("\n");
}
