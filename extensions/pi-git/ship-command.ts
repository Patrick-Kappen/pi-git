import type { Config } from "./config.ts";
import type { Runner } from "./exec.ts";
import { createShip, indexShip, loadShip, planLines, type ShipIndex, saveShip, shipLines } from "./ship.ts";

/** The part of pi's UI that /ship uses; tests pass a fake. */
export interface ShipUi {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  setWidget(key: string, content: string[] | undefined): void;
}

const WIDGET = "pi-git-ship";

interface Choices {
  releases: string[];
  /** Per library: the PR whose title becomes a feat, so a release follows. */
  retitles: Record<string, number>;
}

/** Ask per library whether it releases; for changes without a feat or fix, whether one becomes a feat. */
async function pickReleases(ui: ShipUi, index: ShipIndex): Promise<Choices> {
  const choices: Choices = { releases: [], retitles: {} };
  for (const lib of index.libs) {
    if (lib.releasable) {
      const what = lib.releasePr ? lib.releasePr.title : "the release after the merges";
      if ((await ui.select(`Release ${lib.repo}? (${what})`, ["Release", "Skip"])) === "Release") {
        choices.releases.push(lib.repo);
      }
    } else if (lib.noRelease !== undefined) {
      const pr = lib.ready.find((item) => item.number === lib.noRelease);
      const answer = await ui.select(
        `${lib.repo} changes, but no release follows: make #${lib.noRelease} (${pr?.title}) a feat?`,
        ["Make it a feat and release", "No release"],
      );
      if (answer === "Make it a feat and release") {
        choices.releases.push(lib.repo);
        choices.retitles[lib.repo] = lib.noRelease;
      }
    }
  }
  return choices;
}

/** /ship and /ship status: index, show the plan and its problems, pick releases, confirm, then the watcher runs it. */
export async function shipCommand(args: string, ui: ShipUi, deps: { run: Runner; config: Config }): Promise<void> {
  const { config } = deps;
  const current = loadShip(config.stateDir);
  if (args.trim() === "status" || current?.status === "running") {
    ui.setWidget(WIDGET, current ? [`ship ${current.id}: ${current.status}`, ...shipLines(current)] : ["no ship yet"]);
    if (current?.status === "running") ui.notify("A ship is running; /ship status shows it.", "info");
    return;
  }
  if (!config.shipNixos) {
    ui.notify("Set shipNixos (programs.pi-git.ship.nixos) to the NixOS configuration first.", "error");
    return;
  }
  ui.notify("pi-git ship: looking at every repository…", "info");
  const index = await indexShip(deps.run, config.shipNixos);
  ui.setWidget(WIDGET, ["/ship plan", ...planLines(index)]);
  const { releases, retitles } = await pickReleases(ui, index);
  const ship = createShip(index, releases, config.shipHost, new Date(), retitles);
  if (ship.libs.length === 0 && ship.nixos.prs.length === 0) {
    ui.setWidget(WIDGET, undefined);
    ui.notify("pi-git ship: nothing to ship.", "info");
    return;
  }
  const ok = await ui.confirm(
    "Ship?",
    `Merge, release ${releases.length > 0 ? releases.join(", ") : "nothing"}, lock in ${index.nixos.repo}, and wait for deploy-${config.shipHost}. It runs in the background; you get a notification when it is done or needs you.`,
  );
  ui.setWidget(WIDGET, undefined);
  if (!ok) return;
  saveShip(config.stateDir, ship);
  ui.notify("pi-git ship: running in the background (the watcher, every minute).", "info");
}
