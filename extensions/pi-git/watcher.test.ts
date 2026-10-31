import { expect, test, vi } from "vitest";

vi.mock("./config.ts", () => ({ loadConfig: vi.fn(() => ({ errors: ["invalid config"] })) }));
vi.mock("./exec.ts", () => ({ run: vi.fn() }));
vi.mock("./pr.ts", () => ({ gitPr: vi.fn() }));
vi.mock("./ship.ts", () => ({ shipTick: vi.fn(async () => undefined) }));
vi.mock("./watch.ts", () => ({ tick: vi.fn(async () => 2) }));
vi.mock("./watch-loop.ts", () => ({
  runWatcher: vi.fn(
    async (parts: {
      prs: () => Promise<number>;
      ship: () => Promise<unknown>;
      sleep: (ms: number) => Promise<void>;
      log: (text: string) => void;
    }) => {
      await parts.prs();
      await parts.ship();
      await parts.sleep(0);
      parts.log("watcher finished");
    },
  ),
}));

test("the watcher wires config, PR rounds, ship ticks, sleep, and logging", async () => {
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await import("./watcher.ts");
  const [{ loadConfig }, { run }, { gitPr }, { shipTick }, { tick }, { runWatcher }] = await Promise.all([
    import("./config.ts"),
    import("./exec.ts"),
    import("./pr.ts"),
    import("./ship.ts"),
    import("./watch.ts"),
    import("./watch-loop.ts"),
  ]);
  expect(loadConfig).toHaveBeenCalledOnce();
  expect(stderr).toHaveBeenCalledWith("pi-git: invalid config\n");
  expect(stdout).toHaveBeenCalledWith("watcher finished\n");
  expect(tick).toHaveBeenCalledWith({ run, config: { errors: ["invalid config"] }, gitPr, log: expect.any(Function) });
  expect(shipTick).toHaveBeenCalledWith({
    run,
    config: { errors: ["invalid config"] },
    gitPr,
    log: expect.any(Function),
  });
  expect(runWatcher).toHaveBeenCalledOnce();
  const parts = vi.mocked(runWatcher).mock.calls[0]?.[0];
  expect(parts).toBeDefined();
  expect(parts?.sleep).toBeTypeOf("function");
  await parts?.sleep(0);
});
