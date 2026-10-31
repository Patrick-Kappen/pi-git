// The watcher: the queued PRs and a running ship, side by side. A systemd timer runs it; see
// nix/home-manager.nix. While a ship runs, this run stays alive until the ship is done.
// Usage: node watcher.ts
import { loadConfig } from "./config.ts";
import { run } from "./exec.ts";
import { gitPr } from "./pr.ts";
import { shipTick } from "./ship.ts";
import { tick } from "./watch.ts";
import { runWatcher } from "./watch-loop.ts";

const config = loadConfig();
for (const error of config.errors) process.stderr.write(`pi-git: ${error}\n`);
const log = (text: string) => process.stdout.write(`${text}\n`);
await runWatcher({
  prs: () => tick({ run, config, gitPr, log }),
  ship: () => shipTick({ run, config, gitPr, log }),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log,
});
