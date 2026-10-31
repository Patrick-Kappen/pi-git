import type { Config } from "./config.ts";
import type { Runner } from "./exec.ts";
import { createShip, indexShip, loadShip, planLines, saveShip, shipLines } from "./ship.ts";

/** The part of pi's UI that /ship uses; tests pass a fake. */
export interface ShipUi {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setWidget(key: string, content: string[] | undefined): void;
}

const WIDGET = "pi-git-ship";

/** /ship and /ship status: index, show the plan, and let the watcher run it; no questions. */
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
  // Every library with a feat or fix releases; for the others the reviewing agent decides. No questions:
  // only a fix that would change behavior comes back to the owner, as a notification.
  const releases = index.libs.filter((lib) => lib.releasable).map((lib) => lib.repo);
  const ship = createShip(index, releases, config.shipHost, new Date());
  if (ship.libs.length === 0 && ship.nixos.prs.length === 0) {
    ui.notify("pi-git ship: nothing to ship.", "info");
    return;
  }
  saveShip(config.stateDir, ship);
  ui.setWidget(WIDGET, ["/ship: running in the background", ...planLines(index)]);
  ui.notify(
    "pi-git ship: running in the background. You get a notification when it is done, or when a fix would change behavior.",
    "info",
  );
}
