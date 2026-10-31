import { describe, expect, test } from "vitest";
import type { Ship } from "./ship.ts";
import { PRS_EVERY_MS, runWatcher, SHIP_EVERY_MS } from "./watch-loop.ts";

/** A clock that only moves when someone sleeps, so the loops run in a known order. */
function world(shipRounds: number, prRoundMs = 0) {
  const events: string[] = [];
  let now = 0;
  let shipLeft = shipRounds;
  const waits: { until: number; resolve: () => void }[] = [];
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      waits.push({ until: now + ms, resolve });
    });
  const pump = async () => {
    for (let i = 0; i < 10_000; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      if (waits.length === 0) return;
      waits.sort((a, b) => a.until - b.until);
      const next = waits.shift();
      if (!next) return;
      now = Math.max(now, next.until);
      next.resolve();
    }
  };
  return {
    events,
    parts: {
      prs: async () => {
        events.push(`prs@${now}`);
        if (prRoundMs > 0) await sleep(prRoundMs);
        return 0;
      },
      ship: async () => {
        events.push(`ship@${now}`);
        shipLeft--;
        return { status: shipLeft > 0 ? "running" : "done" } as Ship;
      },
      sleep,
      log: () => {},
    },
    pump,
  };
}

describe("runWatcher", () => {
  test("no ship: one round over the PRs, and the run ends", async () => {
    const w = world(0);
    const done = runWatcher(w.parts);
    await w.pump();
    await done;
    expect(w.events).toEqual(["ship@0", "prs@0"]);
  });

  test("a running ship looks every 10 seconds, the PRs every minute, and the run ends with the ship", async () => {
    const w = world(8);
    const done = runWatcher(w.parts);
    await w.pump();
    await done;
    const ship = w.events.filter((e) => e.startsWith("ship")).map((e) => Number(e.split("@")[1]));
    const prs = w.events.filter((e) => e.startsWith("prs")).map((e) => Number(e.split("@")[1]));
    expect(ship).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((i) => i * SHIP_EVERY_MS));
    expect(prs).toEqual([0, PRS_EVERY_MS]);
  });

  test("a slow round over the PRs (a helper fix) does not hold the ship up", async () => {
    const w = world(4, 5 * 60_000);
    const done = runWatcher(w.parts);
    await w.pump();
    await done;
    const ship = w.events.filter((e) => e.startsWith("ship")).map((e) => Number(e.split("@")[1]));
    expect(ship).toEqual([0, 10_000, 20_000, 30_000]);
  });
});
