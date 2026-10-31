import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { type CheckInput, detectCommand, gitCheck } from "./check.ts";
import { defaults } from "./config.ts";
import { run } from "./exec.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-git-check-")));
const repo = join(root, "repo");
const pi = join(root, "pi");

beforeAll(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  // The helper: fixes by writing OK, gives up on request, and summarizes.
  writeFileSync(
    pi,
    `#!/bin/sh
input=$(cat)
case "$PI_GIT_HELPER" in
  fix) case "$input" in *STUCK*) echo "CANNOT FIX: needs a decision" ;; *NOFIX*) echo "tried" ;; *) echo OK > state.txt; echo "Set state.txt to OK." ;; esac ;;
  answer) echo "- test a.ts:3: expected OK" ;;
esac
`,
  );
  chmodSync(pi, 0o755);
});

const config = { ...defaults("p", {}, "/home/u"), pi, attempts: 2 };
const steps: string[] = [];
const check = (input: Partial<CheckInput>) =>
  gitCheck({ path: repo, ...input }, { run, config, progress: (step) => steps.push(step) });
const failing = (word: string) => `grep -q OK state.txt 2>/dev/null || { echo "${word}: state is not OK"; exit 1; }`;

describe("gitCheck", () => {
  test("green", async () => {
    const result = await check({ command: "true" });
    expect(result).toMatchObject({ ok: true, command: "true", notes: [] });
    expect(result.summary).toMatch(/^Checks passed: `true` \(\d+s\)\.$/);
  });

  test("red: the helper fixes it", async () => {
    writeFileSync(join(repo, "state.txt"), "BAD\n");
    const result = await check({ command: failing("FIXME") });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("The helper fixed:\n- Set state.txt to OK.");
    expect(readFileSync(join(repo, "state.txt"), "utf8")).toBe("OK\n");
    expect(steps).toContain("checks fail; the helper fixes them (attempt 1/2)");
  });

  test("red without fixing: a summary", async () => {
    writeFileSync(join(repo, "state.txt"), "BAD\n");
    const result = await check({ command: failing("x"), fix: false });
    expect(result).toMatchObject({
      ok: false,
      summary: `Checks fail: \`${failing("x")}\`\n- test a.ts:3: expected OK`,
    });
  });

  test("red after all attempts: what the helper tried, and a summary", async () => {
    writeFileSync(join(repo, "state.txt"), "BAD\n");
    const result = await check({ command: failing("NOFIX") });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("- test a.ts:3: expected OK\nThe helper tried:\n- tried\n- tried");
  });

  test("the helper cannot fix it", async () => {
    writeFileSync(join(repo, "state.txt"), "BAD\n");
    const result = await check({ command: failing("STUCK") });
    expect(result.summary).toContain("CANNOT FIX: needs a decision");
    expect(result.summary).toContain("STUCK: state is not OK");
  });

  test("the helper fails; the summary falls back to the output", async () => {
    const broken = { ...config, pi: "false" };
    const run1 = await gitCheck(
      { path: repo, command: "echo boom; exit 1" },
      { run, config: broken, progress: () => {} },
    );
    expect(run1.summary).toContain("Checks fail: `echo boom; exit 1`, and the helper failed");
    const run2 = await gitCheck(
      { path: repo, command: "echo boom; exit 1", fix: false },
      { run, config: broken, progress: () => {} },
    );
    expect(run2.summary).toBe("Checks fail: `echo boom; exit 1`\nboom");
  });

  test("not a repository, or no command", async () => {
    expect((await check({ path: root })).summary).toContain("is not in a git repository");
    expect((await check({})).summary).toContain("no check command found");
  });
});

describe("detectCommand", () => {
  function dir(files: Record<string, string>): string {
    const path = mkdtempSync(join(tmpdir(), "pi-git-detect-"));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(path, name), text);
    return path;
  }

  test.each<[Record<string, string>, string | undefined]>([
    [
      { "devenv.nix": 'scripts.check.exec = "x";', "package.json": '{"scripts":{"test":"t"}}' },
      "devenv shell -- check",
    ],
    [{ "devenv.nix": "{ }", "package.json": '{"scripts":{"check":"c","test":"t"}}' }, "npm run check"],
    [{ "package.json": '{"scripts":{"test":"t"}}' }, "npm test"],
    [{ "package.json": "{", "flake.nix": "{ }" }, "nix flake check"],
    [{ "package.json": "{}", Makefile: "build:\n\ncheck:\n\ttrue\n" }, "make check"],
    [{ Makefile: "test:\n\ttrue\n" }, "make test"],
    [{}, undefined],
  ])("%j", (files, command) => {
    expect(detectCommand(dir(files))).toBe(command);
  });
});
