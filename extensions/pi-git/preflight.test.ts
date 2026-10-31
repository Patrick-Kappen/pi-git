import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { run } from "./exec.ts";
import { conflictRegions, parseVerdicts, preflightInput, simulate } from "./preflight.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-git-preflight-")));
const origin = join(root, "origin.git");
const work = join(root, "work");
const main = join(root, "main");
const g = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, PI_GIT_SWITCH: "" } }).trim();

/** A PR: a branch from `from` with one file change, published as refs/pull/<n>/head. */
function pr(n: number, from: string, file: string, text: string): string {
  g(work, "switch", "-q", "-C", `pr${n}`, from);
  writeFileSync(join(work, file), text);
  g(work, "add", ".");
  g(work, "commit", "-q", "-m", `pr ${n}`);
  g(work, "push", "-q", "-f", "origin", `HEAD:refs/pull/${n}/head`);
  return `pr${n}`;
}

beforeAll(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  mkdirSync(work);
  g(work, "init", "-q", "-b", "main");
  g(work, "config", "user.email", "t@t");
  g(work, "config", "user.name", "t");
  writeFileSync(join(work, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(work, "b.txt"), "b\n");
  g(work, "add", ".");
  g(work, "commit", "-q", "-m", "start");
  g(work, "remote", "add", "origin", origin);
  g(work, "push", "-q", "origin", "main");
  // #1 and #2 change the same line: #2 conflicts with #1. #3 is clean. #4 is stacked on #3.
  pr(1, "main", "a.txt", "one\nTWO by 1\nthree\n");
  pr(2, "main", "a.txt", "one\nTWO by 2\nthree\n");
  pr(3, "main", "b.txt", "b\nmore\n");
  pr(4, "pr3", "b.txt", "b\nmore\neven more\n");
  execFileSync("git", ["clone", "-q", origin, main]);
});

describe("simulate", () => {
  test("clean PRs, a conflict with an earlier PR (files, markers), and a stacked PR with only its own commits", async () => {
    const result = await simulate(run, main, "main", [
      { number: 1 },
      { number: 2 },
      { number: 3 },
      { number: 4, onto: 3 },
    ]);
    if (typeof result === "string") throw new Error(result);
    // Clean ones land first; #2 conflicts with #1 and moves to the end.
    expect(result.map((item) => [item.number, item.clean])).toEqual([
      [1, true],
      [3, true],
      [4, true],
      [2, false],
    ]);
    const second = result.find((item) => item.number === 2);
    expect(second).toMatchObject({ conflicts: ["a.txt"], against: [1] });
    expect(second?.markers).toContain("<<<<<<<");
    expect(second?.markers).toContain("TWO by 1");
    expect(second?.markers).toContain("TWO by 2");
    // The stacked PR changes only what it adds on top of #3.
    expect(result.find((item) => item.number === 4)?.files).toEqual(["b.txt"]);
    // Nothing was written to a branch.
    expect(g(main, "branch", "--list")).toBe("* main");
  });

  test("the order lands as much as possible cleanly: a conflicting PR moves back, a needed PR goes first", async () => {
    // #2 conflicts with #1; #3 is clean. Greedy: #1, #3 land; #2 conflicts with #1 at the end.
    const order = await simulate(run, main, "main", [{ number: 1 }, { number: 2 }, { number: 3 }]);
    if (typeof order === "string") throw new Error(order);
    expect(order.map((item) => [item.number, item.clean])).toEqual([
      [1, true],
      [3, true],
      [2, false],
    ]);
    // #1 needs #3 (it uses what #3 adds): #3 lands first.
    const needs = await simulate(run, main, "main", [{ number: 1, after: [3] }, { number: 2 }, { number: 3 }]);
    if (typeof needs === "string") throw new Error(needs);
    expect(needs.findIndex((item) => item.number === 3)).toBeLessThan(needs.findIndex((item) => item.number === 1));
  });

  test("a stacked PR waits for its base, even when it would land cleanly itself", async () => {
    const order = await simulate(run, main, "main", [{ number: 4, onto: 3 }, { number: 3 }]);
    if (typeof order === "string") throw new Error(order);
    expect(order.map((item) => item.number)).toEqual([3, 4]);
  });

  test("a PR that does not exist: an error, not a crash", async () => {
    expect(await simulate(run, main, "main", [{ number: 99 }])).toMatch(/^git fetch failed/);
  });
});

describe("the agent's part", () => {
  test("conflictRegions keeps the markers with a little context", () => {
    const text = ["a", "b", "c", "d", "<<<<<<< x", "mine", "=======", "theirs", ">>>>>>> y", "e", "f", "g", "h"].join(
      "\n",
    );
    expect(conflictRegions(text, 1)).toBe(
      ["…", "d", "<<<<<<< x", "mine", "=======", "theirs", ">>>>>>> y", "e"].join("\n"),
    );
  });

  test("parseVerdicts wants one verdict per PR", () => {
    const parse = parseVerdicts([1, 2]);
    expect(parse({ verdicts: [{ pr: 1, action: "ship" }] })).toBeInstanceOf(Error);
    expect(parse({ verdicts: [{ pr: 1, action: "merge" }] })).toBeInstanceOf(Error);
    expect(parse({})).toBeInstanceOf(Error);
    expect(
      parse({
        verdicts: [
          { pr: 1, action: "ship", reason: "clean" },
          { pr: 2, action: "skip", reason: "behavior" },
        ],
      }),
    ).toEqual([
      { pr: 1, action: "ship", reason: "clean" },
      { pr: 2, action: "skip", reason: "behavior" },
    ]);
  });

  test("preflightInput shows each PR with its simulation", () => {
    const input = preflightInput(
      "o/r",
      [
        { number: 1, title: "feat: a", body: "Why." },
        { number: 2, title: "feat: b", note: "the watcher fixes it: checks fail" },
      ],
      [
        { number: 1, clean: true, files: ["a.txt"], conflicts: [], against: [], markers: "" },
        {
          number: 2,
          clean: false,
          files: ["a.txt"],
          conflicts: ["a.txt"],
          against: [1],
          markers: "--- a.txt\n<<<<<<<",
        },
      ],
    );
    expect(input).toContain("## #1 feat: a\nState: green and mergeable\nFiles: a.txt\nSimulation: clean\nBody:\nWhy.");
    expect(input).toContain("Simulation: conflicts in a.txt (with #1)\n--- a.txt\n<<<<<<<");
    expect(preflightInput("o/r", [{ number: 1, title: "t" }], "no local checkout")).toContain(
      "No simulation (no local checkout); decide from the PRs.",
    );
  });
});
