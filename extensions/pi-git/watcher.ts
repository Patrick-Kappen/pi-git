// The watcher: one round over the queued PRs. A systemd timer runs it; see nix/home-manager.nix.
// Usage: node watcher.ts
import { loadConfig } from "./config.ts";
import { run } from "./exec.ts";
import { gitPr } from "./pr.ts";
import { SHIP_POLL_MS, SHIP_WINDOW_MS, shipTick } from "./ship.ts";
import { tick } from "./watch.ts";

const config = loadConfig();
for (const error of config.errors) process.stderr.write(`pi-git: ${error}\n`);
const count = await tick({ run, config, gitPr, log: (text) => process.stdout.write(`${text}\n`) });
process.stdout.write(`pi-git watcher: ${count} PR(s) checked\n`);
// While a ship runs, look every 10 seconds within this run of the timer (once a minute), so a ship
// does not wait a minute for each check that finished.
const started = Date.now();
const log = (text: string) => process.stdout.write(`${text}\n`);
let ship = await shipTick({ run, config, gitPr, log });
while (ship?.status === "running" && Date.now() - started < SHIP_WINDOW_MS) {
  await new Promise((resolve) => setTimeout(resolve, SHIP_POLL_MS));
  ship = await shipTick({ run, config, gitPr, log });
}
if (ship?.status === "running") process.stdout.write("pi-git watcher: a ship is running\n");
