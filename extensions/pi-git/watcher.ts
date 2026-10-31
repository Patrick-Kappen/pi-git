// The watcher: one round over the queued PRs. A systemd timer runs it; see nix/home-manager.nix.
// Usage: node watcher.ts
import { loadConfig } from "./config.ts";
import { run } from "./exec.ts";
import { gitPr } from "./pr.ts";
import { tick } from "./watch.ts";

const config = loadConfig();
for (const error of config.errors) process.stderr.write(`pi-git: ${error}\n`);
const count = await tick({ run, config, gitPr, log: (text) => process.stdout.write(`${text}\n`) });
process.stdout.write(`pi-git watcher: ${count} PR(s) checked\n`);
