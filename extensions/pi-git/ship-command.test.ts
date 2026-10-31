import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { defaults } from "./config.ts";
import type { Runner } from "./exec.ts";
import { indexShip, loadShip, type Ship, type ShipIndex, saveShip } from "./ship.ts";
import { type ShipUi, shipCommand } from "./ship-command.ts";

const INDEX: ShipIndex = {
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
    {
      repo: "o/c",
      input: "c",
      ready: [{ number: 5, title: "docs: y", sha: "s", url: "u" }],
      problems: [],
      releasable: false,
      noRelease: 5,
      behind: false,
    },
  ],
  nixos: { repo: "o/Nixos", root: "/n", ready: [], problems: [], releasable: false, behind: false },
};

vi.mock("./ship.ts", async (original) => ({
  ...(await original<typeof import("./ship.ts")>()),
  indexShip: vi.fn(async () => INDEX),
}));

function ui() {
  const log: string[] = [];
  const fake: ShipUi = {
    notify: (message) => log.push(`notify ${message}`),
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
  test("no questions: every feat or fix releases, the rest goes to the reviewing agent, and it runs", async () => {
    const c = config();
    const { fake, log } = ui();
    await shipCommand("", fake, { run, config: c });
    expect(log[1]).toBe(
      "widget /ship: running in the background | o/a: merge #1; a release follows | o/b: nothing |   not shipped: #2 t: draft | o/c: merge #5; no release follows (no feat or fix) | o/Nixos: nothing",
    );
    expect(log[2]).toMatch(/running in the background.*change behavior/);
    expect(loadShip(c.stateDir)).toMatchObject({
      status: "running",
      host: "gaia",
      libs: [
        { repo: "o/a", release: true },
        { repo: "o/c", release: false, review: [5] },
      ],
    });
  });

  test("nothing to ship", async () => {
    vi.mocked(indexShip).mockResolvedValueOnce({ libs: [], nixos: INDEX.nixos });
    const c = config();
    const { fake, log } = ui();
    await shipCommand("", fake, { run, config: c });
    expect(log.at(-1)).toBe("notify pi-git ship: nothing to ship.");
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
