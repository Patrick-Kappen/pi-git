import type { Ship } from "./ship.ts";

export interface LoopParts {
  /** One round over the queued PRs; may take minutes when the helper fixes something. */
  prs: () => Promise<number>;
  /** One round of the running ship. */
  ship: () => Promise<Ship | undefined>;
  sleep: (ms: number) => Promise<void>;
  log: (text: string) => void;
}

/** How often the ship looks while it runs. */
export const SHIP_EVERY_MS = 10_000;
/** How often the queued PRs are looked at while a ship keeps this run alive. */
export const PRS_EVERY_MS = 60_000;

/**
 * One run of the watcher. The ship and the PRs move side by side, so a fix by the helper (minutes)
 * never holds the ship up. While a ship runs, the run stays alive: the ship looks every 10 seconds
 * and the PRs every minute, without waiting for the timer between runs.
 */
export async function runWatcher(parts: LoopParts): Promise<void> {
  let shipping = true;
  const ship = (async () => {
    let state = await parts.ship();
    while (state?.status === "running") {
      await parts.sleep(SHIP_EVERY_MS);
      state = await parts.ship();
    }
    shipping = false;
  })();
  const prs = (async () => {
    for (;;) {
      parts.log(`pi-git watcher: ${await parts.prs()} PR(s) checked`);
      if (!shipping) return;
      // Sleep in steps, so the run ends soon after the ship.
      for (let waited = 0; waited < PRS_EVERY_MS && shipping; waited += SHIP_EVERY_MS) {
        await parts.sleep(SHIP_EVERY_MS);
      }
      if (!shipping) return;
    }
  })();
  await Promise.all([ship, prs]);
}
