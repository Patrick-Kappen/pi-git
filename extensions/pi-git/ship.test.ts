import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { listAttention } from "./attention.ts";
import { type Config, defaults } from "./config.ts";
import { type Runner, run } from "./exec.ts";
import type { gitPr as GitPr } from "./pr.ts";
import {
  createShip,
  indexShip,
  latestInputs,
  loadShip,
  notReady,
  planLines,
  type Ship,
  STAGE_TIMEOUT_MS,
  saveShip,
  shipLines,
  shipTick,
} from "./ship.ts";
import { type Entry, entryId, loadEntries, loadSummaries, removeEntry, saveEntry } from "./state.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-git-ship-")));
const nixos = join(root, "nixos");
const origin = join(root, "o", "Nixos.git");
const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const LOCK = {
  root: "root",
  nodes: {
    root: { inputs: { "pi-git": "pi-git", "pi-skills": "pi-skills", nixpkgs: "nixpkgs", follows: ["a", "b"] } },
    "pi-git": { original: { type: "github", owner: "o", repo: "pi-git", ref: "latest" }, locked: { rev: "old-git" } },
    "pi-skills": {
      original: { type: "github", owner: "o", repo: "pi-skills", ref: "latest" },
      locked: { rev: "skills-latest" },
    },
    nixpkgs: {
      original: { type: "github", owner: "NixOS", repo: "nixpkgs", ref: "nixos-unstable" },
      locked: { rev: "x" },
    },
  },
};

beforeAll(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];
  process.env.PI_GIT_NO_NOTIFY = "1";
  mkdirSync(join(root, "o"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  mkdirSync(nixos);
  g(nixos, "init", "-q", "-b", "main");
  g(nixos, "config", "user.email", "t@t");
  g(nixos, "config", "user.name", "t");
  writeFileSync(join(nixos, "flake.lock"), JSON.stringify(LOCK));
  g(nixos, "add", ".");
  g(nixos, "commit", "-q", "-m", "first");
  g(nixos, "remote", "add", "origin", origin);
  g(nixos, "push", "-q", "-u", "origin", "main");
  g(nixos, "remote", "set-head", "origin", "main");
});

const green = [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }];
const pending = [{ __typename: "CheckRun", name: "test", status: "IN_PROGRESS" }];
const pr = (number: number, title: string, extra: object = {}) => ({
  number,
  title,
  url: `u${number}`,
  isDraft: false,
  mergeable: "MERGEABLE",
  statusCheckRollup: green,
  headRefOid: `sha${number}`,
  labels: [],
  ...extra,
});

/** The fake GitHub: mutable per test. */
let world: {
  prs: Record<string, object[]>;
  merged: string[];
  latest: Record<string, string>;
  tags: Record<string, string>;
  releaseRun: { status: string; conclusion: string } | undefined;
  deploy: { name: string; status: string; conclusion: string | null } | undefined;
  nixosPr: object | undefined;
  fail: string[];
  repos?: string[];
  releasing?: string[];
};

const calls: string[] = [];
type Reply = { code: number; stdout: string; stderr: string };
const ok = (value: unknown): Reply => ({
  code: 0,
  stdout: typeof value === "string" ? value : JSON.stringify(value),
  stderr: "",
});
const no: Reply = { code: 1, stdout: "", stderr: "" };
const merged = (repo: string, n: string) => world.merged.includes(`${repo}#${n}`);

function prList(repo: string, args: readonly string[]): Reply {
  const list = (world.prs[repo] ?? []) as { labels: object[] }[];
  return ok(args.includes("--label") ? list.filter((item) => item.labels.length > 0) : list);
}

function prView(repo: string, args: readonly string[]): Reply {
  const n = args[2] ?? "";
  if (args.includes("mergeCommit")) return ok(merged(repo, n) ? `merge-${n}` : "");
  const all = [...(world.prs[repo] ?? []), ...(world.nixosPr ? [world.nixosPr] : [])] as {
    number: number;
    state?: string;
  }[];
  const found = all.find((item) => String(item.number) === n);
  if (!found) return no;
  return ok({ ...found, state: merged(repo, n) ? "MERGED" : (found.state ?? "OPEN") });
}

function api(path: string): Reply {
  const config = /^repos\/([^/]+\/[^/]+)\/contents\/release-please-config\.json$/.exec(path);
  if (config) return (world.releasing ?? []).includes(config[1] ?? "") ? ok("release-please-config.json") : no;
  if (path.endsWith("/check-runs")) return ok(world.deploy ? [world.deploy] : []);
  const commit = /^repos\/([^/]+\/[^/]+)\/commits\/(.+)$/.exec(path);
  if (!commit) return ok({ squash: false, merge: true });
  const [, r = "", ref = ""] = commit;
  if (ref === "HEAD") return ok(`${r}-head`);
  const sha = ref === "latest" ? world.latest[r] : world.tags[`${r}@${ref}`];
  return sha ? ok(sha) : no;
}

function ghReply(args: readonly string[]): Reply {
  const repo = args[args.indexOf("-R") + 1] ?? "";
  const key = `${args[0]} ${args[1]}`;
  if (key === "pr list") return prList(repo, args);
  if (key === "repo list") return ok((world.repos ?? []).map((nameWithOwner) => ({ nameWithOwner })));
  if (key === "pr view") return prView(repo, args);
  if (key === "pr edit") return ok("");
  if (key === "pr merge") {
    world.merged.push(`${repo}#${args[2]}`);
    return ok("");
  }
  if (args[0] === "run") return ok(world.releaseRun ? [world.releaseRun] : []);
  return args[0] === "api" ? api(args[1] ?? "") : no;
}

const fake: Runner = async (command, args, options) => {
  const line = `${command} ${args.join(" ")}`;
  calls.push(line);
  if (world.fail.some((part) => line.includes(part))) return { code: 1, stdout: "", stderr: `failed: ${line}` };
  if (command === "nix") return ok("");
  if (command === "tmux") return no;
  return command === "gh" ? ghReply(args) : run(command, args, options);
};

let config: Config;
let clock = new Date("2026-01-01T00:00:00Z");
let n = 0;
const gitPr = vi.fn<typeof GitPr>();
const watched: string[] = [];
const watchPr = vi.fn(async (repo: string, number: number) => {
  watched.push(`${repo}#${number}`);
  // The watcher follows it: an entry in the queue.
  saveEntry(config.stateDir, { id: entryId(repo, number), repo, number } as Entry);
  return undefined;
});
// One pass per tick, so each test can look at every step; "a round keeps going" tests the default.
const fixes: string[] = [];
const fixNow = (repo: string, number: number) => {
  fixes.push(`${repo}#${number}`);
};
let skips: Record<string, { pr: number; reason: string }[]> = {};
const preflight = async (repo: string) => skips[repo] ?? [];
const tick = () => shipTick({ run: fake, config, gitPr, now: () => clock, watchPr, fixNow, preflight }, 1);

beforeEach(() => {
  n++;
  config = {
    ...defaults("p", {}, root),
    stateDir: join(root, `state${n}`),
    worktrees: join(root, `trees${n}`),
    shipNixos: nixos,
  };
  // A clock of its own per test: the ship's id, and so its branch in the shared repository, differs.
  clock = new Date(Date.UTC(2026, 0, 1, 0, n));
  calls.length = 0;
  world = {
    prs: {
      "o/pi-git": [
        pr(1, "feat: start"),
        pr(2, "fix: draft", { isDraft: true }),
        pr(9, "chore(main): release 0.3.0", { labels: [{ name: "autorelease: pending" }] }),
      ],
      "o/pi-skills": [pr(3, "docs: words", { isDraft: true })],
      "o/Nixos": [pr(5, "feat: host")],
    },
    merged: [],
    latest: { "o/pi-git": "old-git", "o/pi-skills": "skills-new" },
    tags: {},
    releaseRun: undefined,
    deploy: undefined,
    nixosPr: undefined,
    fail: [],
  };
  watched.length = 0;
  fixes.length = 0;
  skips = {};
  gitPr.mockReset();
  gitPr.mockResolvedValue({ ok: true, summary: "PR opened", notes: [], pr: { number: 77, url: "u77" } } as never);
});

describe("index", () => {
  test("latestInputs takes the GitHub inputs on latest", () => {
    expect(latestInputs(JSON.stringify(LOCK))).toEqual([
      { input: "pi-git", repo: "o/pi-git", rev: "old-git" },
      { input: "pi-skills", repo: "o/pi-skills", rev: "skills-latest" },
    ]);
  });

  test.each([
    [{ isDraft: true }, "draft"],
    [{ reviewDecision: "CHANGES_REQUESTED" }, "changes requested"],
    [{ mergeable: "CONFLICTING" }, "conflicts with the base"],
    [{ statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }] }, "checks fail"],
    [{ statusCheckRollup: pending }, "checks still run"],
    [{ mergeable: "UNKNOWN" }, "GitHub has not decided whether it can merge"],
    [{}, undefined],
  ])("notReady %j", (extra, why) => {
    expect(notReady(pr(1, "t", extra) as never)).toBe(why);
  });

  test("indexShip: ready PRs, problems, release PRs and inputs that are behind", async () => {
    const index = await indexShip(fake, nixos);
    expect(index.nixos).toMatchObject({
      repo: "o/Nixos",
      root: nixos,
      ready: [expect.objectContaining({ number: 5 })],
    });
    const [git, skills] = index.libs;
    expect(git).toMatchObject({
      repo: "o/pi-git",
      input: "pi-git",
      releasable: true,
      behind: false,
      releasePr: { number: 9 },
    });
    expect(git?.ready.map((item) => item.number)).toEqual([1]);
    expect(git?.problems).toEqual(["#2 fix: draft: draft"]);
    expect(skills).toMatchObject({ behind: true, releasable: false, problems: ["#3 docs: words: draft"] });
    expect(planLines(index)).toEqual([
      "o/pi-git: merge #1; release PR #9 (chore(main): release 0.3.0)",
      "  not shipped: #2 fix: draft: draft",
      "o/pi-skills: released, not locked yet",
      "  not shipped: #3 docs: words: draft",
      "o/Nixos: merge #5",
    ]);
  });

  test("index explains why pending and failing PRs are not ready", async () => {
    world.prs["o/pi-git"] = [
      pr(4, "feat: pending", { statusCheckRollup: pending }),
      pr(5, "feat: failing", {
        statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }],
      }),
    ];
    const index = await indexShip(fake, nixos);
    expect(index.libs[0]?.ready).toMatchObject([
      { number: 4, note: "waits for its checks" },
      { number: 5, note: "the watcher fixes it: checks fail" },
    ]);
    expect(planLines(index)[0]).toBe(
      "o/pi-git: merge #4 (waits for its checks), #5 (the watcher fixes it: checks fail); a release follows",
    );
  });
});

async function plan(releases: string[]): Promise<Ship> {
  const ship = { ...createShip(await indexShip(fake, nixos), releases, "gaia", clock), sessionId: "s-ship" };
  saveShip(config.stateDir, ship);
  return ship;
}

describe("shipTick", () => {
  test("the whole chain: merge, release, lock, merge, deploy", async () => {
    await plan(["o/pi-git"]);
    let ship = await tick();
    // At the same time: pi-git merged #1, pi-skills (behind only) is done, and NixOS merged its own
    // #5 with a merge commit (its setting) without waiting for the libraries.
    expect(world.merged).toEqual(["o/pi-git#1", "o/Nixos#5"]);
    expect(calls).toContain("gh pr merge 5 -R o/Nixos --merge --match-head-commit sha5");
    expect(ship?.libs.map((lib) => lib.state)).toEqual(["release", "done"]);
    expect(ship?.nixos.state).toBe("libs");

    // The release workflow is still running: wait.
    world.releaseRun = { status: "in_progress", conclusion: "" };
    expect((await tick())?.libs[0]?.state).toBe("release");

    world.releaseRun = { status: "completed", conclusion: "success" };
    ship = await tick();
    expect(world.merged).toContain("o/pi-git#9");
    expect(ship?.libs[0]).toMatchObject({ state: "tag", tag: "v0.3.0" });

    world.tags["o/pi-git@v0.3.0"] = "new-git";
    world.latest["o/pi-git"] = "new-git";
    ship = await tick();
    // pi-git done; NixOS locks the releases.
    expect(ship?.libs[0]?.state).toBe("done");
    expect(ship?.nixos).toMatchObject({ state: "update", inputs: ["pi-git", "pi-skills"] });

    ship = await tick();
    expect(calls.some((line) => line === "nix flake update pi-git pi-skills")).toBe(true);
    expect(gitPr.mock.calls[0]?.[0].intent).toContain("pi-git v0.3.0, pi-skills latest");
    expect(ship?.nixos).toMatchObject({ state: "check", pr: 77 });
    expect(existsSync(ship?.nixos.worktree ?? "")).toBe(true);

    world.nixosPr = { ...pr(77, "flake: lock"), state: "OPEN" };
    ship = await tick();
    expect(world.merged).toContain("o/Nixos#77");
    expect(ship?.nixos).toMatchObject({ state: "deploy", mergeSha: "merge-77" });

    world.deploy = {
      name: "nixbot/effect github:o/Nixos#default.deploy-gaia",
      status: "in_progress",
      conclusion: null,
    };
    expect((await tick())?.nixos.state).toBe("deploy");
    world.deploy = { ...world.deploy, status: "completed", conclusion: "success" };
    ship = await tick();
    expect(ship).toMatchObject({ status: "done", nixos: { state: "done" } });
    expect(existsSync(ship?.nixos.worktree ?? "x")).toBe(false);
    // The end goes into the history of the session that started the ship, once and quietly.
    expect(loadSummaries(config.stateDir).map((item) => [item.status, item.sessionId, item.text])).toEqual([
      ["merged", "s-ship", "pi-git ship: done. Released o/pi-git v0.3.0. Deployed on gaia."],
    ]);
    expect(shipLines(ship as Ship)).toEqual(["o/pi-git: done v0.3.0", "o/pi-skills: done", "o/Nixos: done PR #77"]);
    // A finished ship does nothing more.
    calls.length = 0;
    await tick();
    expect(calls).toEqual([]);
  });

  test("a repository with releases that NixOS does not use yet: shipped and released, not locked", async () => {
    world.repos = ["o/pi-git", "o/pi-tweaks", "o/website", "o/Nixos"];
    world.releasing = ["o/pi-git", "o/pi-tweaks"];
    world.prs["o/pi-tweaks"] = [pr(2, "feat(prompt): replace it")];
    const index = await indexShip(fake, nixos);
    const tweaks = index.libs.find((lib) => lib.repo === "o/pi-tweaks");
    expect(tweaks).toMatchObject({ outside: true, releasable: true });
    expect(index.libs.map((lib) => lib.repo)).toEqual(["o/pi-git", "o/pi-skills", "o/pi-tweaks"]);
    expect(planLines(index).filter((line) => line.startsWith("o/pi-tweaks"))).toEqual([
      "o/pi-tweaks: merge #2; not in the NixOS configuration yet: released, not deployed; a release follows",
    ]);
    saveShip(config.stateDir, createShip(index, ["o/pi-tweaks"], "gaia", clock));
    await tick();
    expect(world.merged).toContain("o/pi-tweaks#2");
  });

  test("PRs the watcher follows go quiet once the ship takes them over", async () => {
    saveEntry(config.stateDir, { id: entryId("o/pi-git", 1), repo: "o/pi-git", number: 1 } as Entry);
    saveEntry(config.stateDir, { id: entryId("o/other", 3), repo: "o/other", number: 3 } as Entry);
    await plan([]);
    await tick();
    const quiet = Object.fromEntries(loadEntries(config.stateDir).map((entry) => [entry.id, entry.quiet ?? false]));
    expect(quiet).toEqual({ [entryId("o/pi-git", 1)]: true, [entryId("o/other", 3)]: false });
  });

  test("a round keeps going while something moves: from merge to the flake.lock PR in one round", async () => {
    world.releaseRun = { status: "completed", conclusion: "success" };
    world.tags["o/pi-git@v0.3.0"] = "new-git";
    world.latest["o/pi-git"] = "new-git";
    await plan(["o/pi-git"]);
    const ship = await shipTick({ run: fake, config, gitPr, now: () => clock, watchPr, preflight });
    expect(world.merged).toEqual(["o/pi-git#1", "o/Nixos#5", "o/pi-git#9"]);
    expect(ship?.libs[0]).toMatchObject({ state: "done", tag: "v0.3.0" });
    // It stops where it has to wait: the checks of the flake.lock PR.
    expect(ship?.nixos).toMatchObject({ state: "check", pr: 77 });
  });

  test("a failing release workflow: that library needs you, the rest goes on", async () => {
    await plan(["o/pi-git"]);
    await tick();
    world.releaseRun = { status: "completed", conclusion: "failure" };
    const ship = await tick();
    expect(ship?.libs[0]).toMatchObject({ state: "failed", error: "the release workflow ended with failure" });
    expect(listAttention(config.stateDir).map((item) => item.text)).toEqual([
      "pi-git ship: o/pi-git needs you: the release workflow ended with failure",
    ]);
    expect(loadSummaries(config.stateDir).map((item) => [item.status, item.text])).toEqual([
      ["failed", "pi-git ship: o/pi-git needs you: the release workflow ended with failure"],
    ]);
    // NixOS continues with pi-skills only.
    expect(ship?.nixos).toMatchObject({ state: "update", inputs: ["pi-skills"] });
  });

  test("waiting longer than the stage timeout fails the stage", async () => {
    await plan(["o/pi-git"]);
    await tick();
    clock = new Date(clock.getTime() + STAGE_TIMEOUT_MS + 1000);
    const ship = await tick();
    expect(ship?.libs[0]).toMatchObject({ state: "failed", error: "waited too long for the release workflow" });
  });

  test("a failed deploy ends the ship with a problem", async () => {
    world.prs["o/pi-git"] = [];
    world.latest = { "o/pi-git": "old-git", "o/pi-skills": "skills-latest" };
    await plan([]);
    let ship = await tick();
    // Only NixOS #5: merged at once, then the deploy of its merge commit.
    expect(ship?.nixos.state).toBe("libs");
    ship = await tick();
    expect(ship?.nixos).toMatchObject({ state: "deploy", mergeSha: "merge-5" });
    world.deploy = { name: "x deploy-gaia", status: "completed", conclusion: "failure" };
    ship = await tick();
    expect(ship).toMatchObject({ status: "done", nixos: { state: "failed", error: "deploy-gaia ended with failure" } });
  });

  test("a merge that fails, and a release PR that fails its checks", async () => {
    world.fail = ["pr merge 1"];
    await plan(["o/pi-git"]);
    let ship = await tick();
    // That PR is given up; the library goes on without it.
    expect(ship?.libs[0]?.prs[0]?.error).toMatch(/^merging #1 failed: failed: gh pr merge 1/);
    expect(listAttention(config.stateDir)[0]?.text).toMatch(/o\/pi-git needs you: merging #1 failed/);

    world.fail = [];
    world.prs["o/pi-git"] = [
      pr(9, "chore(main): release 0.3.1", { labels: [{ name: "autorelease: pending" }], mergeable: "CONFLICTING" }),
    ];
    saveShip(config.stateDir, { ...(loadShip(config.stateDir) as Ship), status: "running" });
    const s = loadShip(config.stateDir) as Ship;
    s.libs[0] = { ...(s.libs[0] as Ship["libs"][number]), state: "release", error: undefined as never, mainSha: "x" };
    saveShip(config.stateDir, s);
    world.releaseRun = { status: "completed", conclusion: "success" };
    ship = await tick();
    expect(ship?.libs[0]?.error).toBe("release PR #9: conflicts with the base");
  });

  test("a PR that conflicts after an earlier merge waits, and merges its new head once ready", async () => {
    world.prs["o/pi-git"] = [pr(1, "feat: one"), pr(4, "feat: two")];
    await plan([]);
    // Merging #1 makes #4 conflict: the watcher gets it, the ship waits.
    world.prs["o/pi-git"] = [pr(1, "feat: one"), pr(4, "feat: two", { mergeable: "CONFLICTING" })];
    let ship = await tick();
    expect(world.merged).toEqual(["o/pi-git#1", "o/Nixos#5"]);
    expect(watched).toEqual(["o/pi-git#4"]);
    // The fix starts at once, not on the watcher's next round.
    expect(fixes).toEqual(["o/pi-git#4"]);
    expect(ship?.libs[0]).toMatchObject({ state: "merge", adopted: [4] });
    // Still conflicting while the watcher works: not handed over twice.
    await tick();
    expect(watched).toEqual(["o/pi-git#4"]);
    // The watcher rebased #4: a new head, green again.
    world.prs["o/pi-git"] = [pr(1, "feat: one"), pr(4, "feat: two", { headRefOid: "rebased4" })];
    ship = await tick();
    expect(calls).toContain("gh pr merge 4 -R o/pi-git --squash --match-head-commit rebased4");
    expect(ship?.libs[0]?.state).toBe("done");
  });

  test("every PR each round, oldest first: a waiting one does not hold up a green one, conflicts are fixed at once and together", async () => {
    world.prs["o/pi-git"] = [pr(1, "feat: a"), pr(2, "feat: b"), pr(3, "feat: c"), pr(4, "feat: d")];
    await plan([]);
    world.prs["o/pi-git"] = [
      pr(1, "feat: a", { statusCheckRollup: pending }),
      pr(2, "feat: b", { mergeable: "CONFLICTING" }),
      pr(3, "feat: c"),
      pr(4, "feat: d", { mergeable: "CONFLICTING" }),
    ];
    const ship = await tick();
    expect(world.merged).toContain("o/pi-git#3");
    expect(fixes).toEqual(["o/pi-git#2", "o/pi-git#4"]);
    expect(ship?.libs[0]?.state).toBe("merge");
  });

  test("the preflight leaves PRs out before anything merges, and tells the owner and the agent once", async () => {
    world.prs["o/pi-git"] = [pr(1, "feat: a"), pr(2, "fix: b")];
    skips = { "o/pi-git": [{ pr: 2, reason: "choosing between two behaviors of the lock" }] };
    await plan(["o/pi-git"]);
    const ship = await tick();
    expect(world.merged).toEqual(["o/pi-git#1", "o/Nixos#5"]);
    expect(ship?.libs[0]?.prs.map((item) => item.number)).toEqual([1]);
    expect(ship?.skipped).toEqual(["o/pi-git#2 fix: b: choosing between two behaviors of the lock"]);
    expect(loadSummaries(config.stateDir).map((item) => item.text)).toEqual([
      "pi-git ship: not shipped, they need you:\n- o/pi-git#2 fix: b: choosing between two behaviors of the lock",
    ]);
  });

  test("when every releasing PR is skipped and no release PR waits, the library does not release", async () => {
    world.prs["o/pi-git"] = [pr(2, "feat: b")];
    skips = { "o/pi-git": [{ pr: 2, reason: "unfinished" }] };
    await plan(["o/pi-git"]);
    const ship = await tick();
    expect(ship?.libs[0]).toMatchObject({ release: false, state: "done" });
  });

  test("the watcher gave up on a red PR: that library needs you", async () => {
    world.prs["o/pi-git"] = [
      pr(4, "feat: red", {
        statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }],
      }),
    ];
    const ship0 = await plan([]);
    expect(ship0.libs[0]?.prs[0]?.note).toBe("the watcher fixes it: checks fail");
    await tick();
    removeEntry(config.stateDir, entryId("o/pi-git", 4));
    const ship = await tick();
    expect(ship?.libs[0]?.prs[0]?.error).toBe("#4: checks fail, and the watcher could not fix it");
    expect(ship?.libs[0]?.state).toBe("done");
  });

  test("a PR without a feat or fix: retitled to feat when the owner chose it", async () => {
    world.prs["o/pi-git"] = [pr(6, "docs(git): words")];
    const index = await indexShip(fake, nixos);
    expect(index.libs[0]).toMatchObject({ releasable: false, noRelease: 6 });
    expect(planLines(index)[0]).toBe("o/pi-git: merge #6; no release follows (no feat or fix)");
    saveShip(config.stateDir, createShip(index, ["o/pi-git"], "gaia", clock, { "o/pi-git": 6 }));
    const ship = await tick();
    expect(calls).toContain("gh pr edit 6 -R o/pi-git --title feat(git): words");
    expect(ship?.libs[0]?.error).toBeUndefined();
    expect(ship?.libs[0]?.state).toBe("release");
  });

  test("the reviewing agent decides a release for changes without feat or fix, with luna at medium", async () => {
    world.prs["o/pi-git"] = [pr(6, "docs(git): skill words")];
    const index = await indexShip(fake, nixos);
    saveShip(config.stateDir, createShip(index, [], "gaia", clock));
    config = { ...config, pi: "pi-fake" };
    const answers: string[] = [];
    const reviewer: Runner = async (command, args, options) => {
      if (command === "pi-fake") {
        answers.push(args.join(" "));
        return ok('{"release": true, "pr": 6, "type": "feat", "reason": "the skill text is shipped"}');
      }
      if (command === "gh" && args[1] === "view" && args.includes("number,title,body,files"))
        return ok({ number: 6, title: "docs(git): skill words", files: [{ path: "skills/git/SKILL.md" }] });
      return fake(command, args, options);
    };
    const ship = await shipTick({ run: reviewer, config, gitPr, now: () => clock, watchPr, preflight });
    expect(answers[0]).toContain("--model openai-codex/gpt-6-luna --thinking medium");
    expect(ship?.reviewed).toBe(true);
    expect(ship?.libs[0]).toMatchObject({ release: true, retitle: [6], retitleType: "feat" });
    expect(calls).toContain("gh pr edit 6 -R o/pi-git --title feat(git): skill words");
  });

  test("the reviewing agent says no release: merged, not released", async () => {
    world.prs["o/pi-git"] = [pr(6, "ci: runner")];
    saveShip(config.stateDir, createShip(await indexShip(fake, nixos), [], "gaia", clock));
    config = { ...config, pi: "pi-fake" };
    const reviewer: Runner = async (command, args, options) =>
      command === "pi-fake" ? ok('{"release": false, "reason": "only CI"}') : fake(command, args, options);
    const ship = await shipTick({ run: reviewer, config, gitPr, now: () => clock, watchPr, preflight });
    expect(ship?.libs[0]).toMatchObject({ release: false, state: "done" });
  });

  test("an unusable review answer is retried and does not release when a PR disappeared", async () => {
    world.prs["o/pi-git"] = [pr(6, "docs(git): skill words")];
    saveShip(config.stateDir, createShip(await indexShip(fake, nixos), [], "gaia", clock));
    config = { ...config, pi: "pi-fake" };
    const answers: string[] = [];
    const logs: string[] = [];
    const reviewer: Runner = async (command, args, options) => {
      if (command === "pi-fake") {
        answers.push(args.join(" "));
        return ok('{"release": true, "pr": 6, "type": "docs"}');
      }
      if (command === "gh" && args[1] === "view" && args.includes("number,title,body,files")) return no;
      return fake(command, args, options);
    };
    const ship = await shipTick({
      run: reviewer,
      config,
      gitPr,
      now: () => clock,
      watchPr,
      preflight,
      log: (text) => logs.push(text),
    });
    expect(answers).toHaveLength(2);
    expect(answers[1]).toContain("previous answer could not be used");
    expect(ship?.libs[0]).toMatchObject({ release: false, state: "done" });
    expect(logs[0]).toContain("no release decision");
  });

  test.each([
    ["not JSON", "no JSON object in the answer"],
    ["{}", '"release" must be true or false'],
    ['{"release":true}', 'a release needs "pr" (a number) and "type" (feat or fix)'],
  ])("an unusable release decision (%s) is retried, then safely ignored", async (answer, problem) => {
    world.prs["o/pi-git"] = [pr(6, "docs(git): skill words")];
    saveShip(config.stateDir, createShip(await indexShip(fake, nixos), [], "gaia", clock));
    config = { ...config, pi: "pi-fake" };
    const prompts: string[] = [];
    const reviewer: Runner = async (command, args, options) => {
      if (command === "pi-fake") {
        prompts.push(args.at(-1) ?? "");
        return ok(answer);
      }
      return fake(command, args, options);
    };
    const ship = await shipTick({ run: reviewer, config, gitPr, now: () => clock, watchPr, preflight });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(`previous answer could not be used (${problem})`);
    expect(ship?.libs[0]).toMatchObject({ release: false, state: "done" });
  });

  test("a release decision for an unknown PR is ignored, including a non-string reason", async () => {
    world.prs["o/pi-git"] = [pr(6, "docs(git): skill words")];
    saveShip(config.stateDir, createShip(await indexShip(fake, nixos), [], "gaia", clock));
    config = { ...config, pi: "pi-fake" };
    const reviewer: Runner = async (command, args, options) =>
      command === "pi-fake" ? ok('{"release":true,"pr":999,"type":"fix","reason":2}') : fake(command, args, options);
    const ship = await shipTick({ run: reviewer, config, gitPr, now: () => clock, watchPr, preflight });
    expect(ship?.libs[0]).toMatchObject({ release: false, state: "done" });
    expect(calls).not.toContain("gh pr edit 6 -R o/pi-git --title fix(git): skill words");
  });

  test("the reviewing agent can classify a change as a fix", async () => {
    world.prs["o/pi-git"] = [pr(6, "docs(git): skill words")];
    saveShip(config.stateDir, createShip(await indexShip(fake, nixos), [], "gaia", clock));
    config = { ...config, pi: "pi-fake" };
    const reviewer: Runner = async (command, args, options) =>
      command === "pi-fake"
        ? ok('{"release":true,"pr":6,"type":"fix","reason":"corrects shipped guidance"}')
        : fake(command, args, options);
    const ship = await shipTick({ run: reviewer, config, gitPr, now: () => clock, watchPr, preflight });
    expect(ship?.libs[0]).toMatchObject({ release: true, retitle: [6], retitleType: "fix" });
    expect(calls).toContain("gh pr edit 6 -R o/pi-git --title fix(git): skill words");
  });

  test("a prefixed release version is preserved even when the merge SHA is unavailable", async () => {
    world.prs["o/pi-git"] = [
      pr(1, "feat: start"),
      pr(9, "chore(main): release v0.3.0", { labels: [{ name: "autorelease: pending" }] }),
    ];
    await plan(["o/pi-git"]);
    const commitQueries: string[] = [];
    const runner: Runner = async (command, args, options) => {
      if (command === "gh" && args[0] === "api" && args[1] === "repos/o/pi-git/commits/HEAD") return ok("");
      if (command === "gh" && args[0] === "run") commitQueries.push(args[args.indexOf("--commit") + 1] ?? "missing");
      return fake(command, args, options);
    };

    await shipTick({ run: runner, config, gitPr, now: () => clock, watchPr });
    world.releaseRun = { status: "completed", conclusion: "success" };
    const ship = await shipTick({ run: runner, config, gitPr, now: () => clock, watchPr });

    expect(commitQueries).toContain("");
    expect(ship?.libs[0]).toMatchObject({ state: "tag", tag: "v0.3.0" });
  });

  test("a stacked PR is never merged into its base's branch: it waits until GitHub moves it to main", async () => {
    world.prs["o/pi-git"] = [
      pr(8, "feat: top", { baseRefName: "feat/base" }),
      pr(7, "feat: base", { headRefName: "feat/base" }),
    ];
    const index = await indexShip(fake, nixos);
    // Base first, the stacked one after it, with a note.
    expect(index.libs[0]?.ready.map((item) => [item.number, item.note])).toEqual([
      [7, undefined],
      [8, "stacked on feat/base: after it"],
    ]);
    saveShip(config.stateDir, createShip(index, [], "gaia", clock));
    let ship = await tick();
    // The stacked PR went to the watcher before its base merged, so it is rebased at once later.
    expect(watched).toEqual(["o/pi-git#8"]);
    expect(world.merged).toEqual(["o/pi-git#7", "o/Nixos#5"]);
    expect(calls.some((line) => line.startsWith("gh pr merge 8"))).toBe(false);
    expect(ship?.libs[0]?.state).toBe("merge");
    // GitHub moved #8 to main after #7 was merged.
    world.prs["o/pi-git"] = [
      pr(7, "feat: base", { headRefName: "feat/base" }),
      pr(8, "feat: top", { baseRefName: "main" }),
    ];
    ship = await tick();
    expect(world.merged).toEqual(["o/pi-git#7", "o/Nixos#5", "o/pi-git#8"]);
    expect(ship?.libs[0]?.state).toBe("done");
  });

  test("stacks are ordered base first, also three high, and a stack without its base is left out", async () => {
    world.prs["o/pi-git"] = [
      pr(9, "feat: third", { baseRefName: "feat/two", headRefName: "feat/three" }),
      pr(4, "feat: one", { headRefName: "feat/one" }),
      pr(6, "feat: two", { baseRefName: "feat/one", headRefName: "feat/two" }),
      pr(5, "feat: lone", { baseRefName: "feat/gone", headRefName: "feat/lone" }),
      pr(3, "feat: plain", { headRefName: "feat/plain" }),
    ];
    const index = await indexShip(fake, nixos);
    expect(index.libs[0]?.ready.map((item) => item.number)).toEqual([3, 4, 6, 9, 5]);
    saveShip(config.stateDir, createShip(index, [], "gaia", clock));
    const ship = await tick();
    expect(ship?.skipped).toEqual(["o/pi-git#5 feat: lone: stacked on feat/gone, whose PR is not shipped"]);
    expect(watched).toEqual(["o/pi-git#6", "o/pi-git#9"]);
  });

  test("a skipped base takes its stack with it", async () => {
    world.prs["o/pi-git"] = [
      pr(4, "feat: one", { headRefName: "feat/one" }),
      pr(6, "feat: two", { baseRefName: "feat/one", headRefName: "feat/two" }),
    ];
    skips = { "o/pi-git": [{ pr: 4, reason: "behavior decision" }] };
    await plan([]);
    const ship = await tick();
    expect(ship?.skipped).toEqual([
      "o/pi-git#4 feat: one: behavior decision",
      "o/pi-git#6 feat: two: stacked on feat/one, whose PR is not shipped",
    ]);
  });

  test("a merge refused because the branch just moved: wait and try again", async () => {
    world.prs["o/pi-git"] = [pr(1, "feat: start")];
    await plan([]);
    world.fail = ["pr merge 1"];
    const realFake = fake;
    const moved: Runner = async (command, args, options) =>
      command === "gh" && args[1] === "merge"
        ? { code: 1, stdout: "", stderr: "GraphQL: Head branch was modified. Review and try the merge again." }
        : realFake(command, args, options);
    let ship = await shipTick({ run: moved, config, gitPr, now: () => clock, watchPr, preflight });
    expect(ship?.libs[0]).toMatchObject({ state: "merge" });
    expect(ship?.libs[0]?.error).toBeUndefined();
    world.fail = [];
    ship = await tick();
    expect(ship?.libs[0]?.state).toBe("done");
  });

  test("no release PR after the merges", async () => {
    world.prs["o/pi-git"] = [pr(1, "feat: start")];
    await plan(["o/pi-git"]);
    await tick();
    world.prs["o/pi-git"] = [];
    world.releaseRun = { status: "completed", conclusion: "success" };
    expect((await tick())?.libs[0]?.error).toMatch(/there is no release PR/);
  });

  test("the flake.lock PR fails its checks", async () => {
    world.prs["o/pi-git"] = [];
    world.prs["o/Nixos"] = [];
    await plan([]);
    await tick();
    await tick();
    await tick();
    world.nixosPr = {
      ...pr(77, "flake: lock", {
        statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }],
      }),
      state: "OPEN",
    };
    const ship = await tick();
    expect(ship?.nixos).toMatchObject({ state: "failed", error: "#77: checks fail" });
  });

  test("the flake.lock PR conflicts after main moved: made again on the fresh main, at most 3 times", async () => {
    world.prs["o/pi-git"] = [];
    world.prs["o/Nixos"] = [];
    await plan([]);
    await tick();
    await tick();
    let ship = await tick();
    expect(ship?.nixos.state).toBe("check");
    const worktree = ship?.nixos.worktree ?? "";
    // Someone merged into main meanwhile; the PR now conflicts.
    world.nixosPr = { ...pr(77, "flake: lock", { mergeable: "CONFLICTING", headRefOid: "lock1" }), state: "OPEN" };
    calls.length = 0;
    ship = await tick();
    expect(calls).toContain("git fetch origin --prune");
    expect(calls).toContain("git reset --hard origin/main");
    expect(calls).toContain("nix flake update pi-skills");
    expect(gitPr.mock.calls.at(-1)?.[0]).toMatchObject({ path: worktree, forceWithLease: "lock1", updatePr: false });
    expect(ship?.nixos).toMatchObject({ state: "check", refreshes: 1 });
    await tick();
    await tick();
    ship = await tick();
    expect(ship?.nixos).toMatchObject({
      state: "failed",
      error: "PR #77 still conflicts after 3 new locks on the default branch",
    });
  });

  test("a failing push of the new lock", async () => {
    world.prs["o/pi-git"] = [];
    world.prs["o/Nixos"] = [];
    await plan([]);
    await tick();
    await tick();
    await tick();
    world.nixosPr = { ...pr(77, "flake: lock", { mergeable: "CONFLICTING" }), state: "OPEN" };
    gitPr.mockResolvedValueOnce({ ok: false, summary: "rejected", notes: [] } as never);
    expect((await tick())?.nixos.error).toBe("the new flake.lock could not be pushed: rejected");
  });

  test("status lines include errors for failed libraries and NixOS", () => {
    const ship: Ship = {
      id: "x",
      host: "gaia",
      status: "running",
      libs: [
        {
          repo: "o/lib",
          input: "lib",
          prs: [],
          release: false,
          behind: false,
          state: "failed",
          since: "",
          error: "needs review",
        },
      ],
      nixos: { repo: "o/Nixos", root: nixos, prs: [], state: "failed", since: "", error: "CI failed" },
    };
    expect(shipLines(ship)).toEqual(["o/lib: failed (needs review)", "o/Nixos: failed (CI failed)"]);
  });

  test("nothing running: no ship, nothing done", async () => {
    expect(await tick()).toBeUndefined();
  });
});
