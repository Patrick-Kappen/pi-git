import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { defaults } from "./config.ts";
import type { Runner } from "./exec.ts";
import { loadShip, type Ship, saveShip } from "./ship.ts";
import { type ShipUi, shipCommand } from "./ship-command.ts";

vi.mock("./ship.ts", async (original) => {
  const real = await original<typeof import("./ship.ts")>();
  return {
    ...real,
    indexShip: vi.fn(async () => ({
      libs: [
        {
          repo: "o/a",
          input: "a",
          ready: [{ number: 1, title: "feat: x", sha: "s", url: "u" }],
          problems: [],
          releasable: true,
          behind: false,
        },
        { repo: "o/b", input: "b", ready: [], problems: ["#2 t: draft"], releasable: false, behind: false },
      ],
      nixos: { repo: "o/Nixos", root: "/n", ready: [], problems: [], releasable: false, behind: false },
    })),
  };
});

function ui(answers: { select?: string; confirm?: boolean } = {}) {
  const log: string[] = [];
  const fake: ShipUi = {
    notify: (message) => log.push(`notify ${message}`),
    select: async (title) => {
      log.push(`select ${title}`);
      return answers.select;
    },
    confirm: async (title) => {
      log.push(`confirm ${title}`);
      return answers.confirm ?? false;
    },
    setWidget: (_key, content) => log.push(`widget ${content ? content.join(" | ") : "-"}`),
  };
  return { fake, log };
}

const run: Runner = async () => ({ code: 1, stdout: "", stderr: "" });
const config = () => ({
  ...defaults("p", {}, "/home/u"),
  stateDir: join(realpathSync(mkdtempSync(join(tmpdir(), "pi-git-shipcmd-"))), "s"),
  shipNixos: "/n",
  shipHost: "gaia",
});

describe("/ship", () => {
  test("plan, pick, confirm: the ship is saved for the watcher", async () => {
    const c = config();
    const { fake, log } = ui({ select: "Release", confirm: true });
    await shipCommand("", fake, { run, config: c });
    expect(log).toContain(
      "widget /ship plan | o/a: merge #1; a release follows | o/b: nothing |   not shipped: #2 t: draft | o/Nixos: nothing",
    );
    expect(log).toContain("select Release o/a? (the release after the merges)");
    expect(loadShip(c.stateDir)).toMatchObject({
      status: "running",
      host: "gaia",
      libs: [{ repo: "o/a", release: true }],
    });
  });

  test("not confirmed: nothing is saved", async () => {
    const c = config();
    await shipCommand("", ui({ select: "Skip", confirm: false }).fake, { run, config: c });
    expect(loadShip(c.stateDir)).toBeUndefined();
  });

  test("status, a running ship, and no NixOS configuration", async () => {
    const c = config();
    const status = ui();
    await shipCommand("status", status.fake, { run, config: c });
    expect(status.log).toEqual(["widget no ship yet"]);
    saveShip(c.stateDir, {
      id: "x",
      host: "gaia",
      status: "running",
      libs: [],
      nixos: { repo: "o/Nixos", root: "/n", prs: [], state: "libs", since: "" },
    } as Ship);
    const running = ui();
    await shipCommand("", running.fake, { run, config: c });
    expect(running.log).toEqual([
      "widget ship x: running | o/Nixos: libs",
      "notify A ship is running; /ship status shows it.",
    ]);
    const none = ui();
    await shipCommand("", none.fake, { run, config: { ...config(), shipNixos: undefined } });
    expect(none.log[0]).toMatch(/Set shipNixos/);
  });
});
