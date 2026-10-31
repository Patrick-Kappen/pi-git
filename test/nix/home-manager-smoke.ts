// Run by the `home-manager` flake check with node: the generated config must load without errors.
// Usage: node home-manager-smoke.ts <home-files> <agent-dir>
import { join } from "node:path";
import type { loadConfig as LoadConfig } from "../../extensions/pi-git/config.ts";
import type { helperArgs as HelperArgs } from "../../extensions/pi-git/helper.ts";

const [homeFiles, agentDir] = process.argv.slice(2);
if (!homeFiles || !agentDir) throw new Error("usage: home-manager-smoke.ts <home-files> <agent-dir>");

const extension = join(homeFiles, agentDir, "extensions", "pi-git");
const { loadConfig }: { loadConfig: typeof LoadConfig } = await import(join(extension, "config.ts"));
const { helperArgs }: { helperArgs: typeof HelperArgs } = await import(join(extension, "helper.ts"));

const config = loadConfig({ PI_GIT_CONFIG: join(homeFiles, agentDir, "pi-git.json") }, "/home/check");
if (config.errors.length > 0) throw new Error(config.errors.join("\n"));
const args = helperArgs(config, { cwd: "/", prompt: "Write it", input: "", fix: false });
const expected = ["--model", "anthropic/claude-haiku-4-5", "--thinking", "xhigh", "--skill"];
if (!expected.every((arg) => args.includes(arg)) || args.at(-1) !== "/skill:git Write it") {
  throw new Error(`unexpected helper arguments: ${JSON.stringify(args)}`);
}
process.stdout.write(`ok ${JSON.stringify(args)}\n`);
