import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  addAttention,
  attentionDir,
  attentionId,
  clearAttention,
  listAttention,
  notifyTerminals,
  osc777,
} from "./attention.ts";
import { type Runner, run } from "./exec.ts";

const fresh = () => mkdtempSync(join(tmpdir(), "pi-git-attention-"));

describe("attention", () => {
  test("add once per kind, repository and step; list; clear", () => {
    const dir = fresh();
    const first = addAttention(
      dir,
      { kind: "blocked", repo: "o/r", step: "push", text: "one" },
      "push",
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(first).toEqual({
      fresh: true,
      item: {
        kind: "blocked",
        repo: "o/r",
        step: "push",
        text: "one",
        id: "blocked__o_r__push",
        created: "2026-01-01T00:00:00.000Z",
      },
    });
    const again = addAttention(dir, { kind: "blocked", repo: "o/r", step: "push", text: "two" });
    expect(again.fresh).toBe(false);
    expect(again.item.created).toBe("2026-01-01T00:00:00.000Z");
    addAttention(dir, { kind: "watcher", repo: "o/r", text: "pr" }, "o__r__7");
    addAttention(dir, { kind: "request", text: "decide" });
    writeFileSync(join(attentionDir(dir), "broken.json"), "{");
    const texts = listAttention(dir).map((item) => item.text);
    expect(texts[0]).toBe("two");
    expect(texts.slice(1).sort()).toEqual(["decide", "pr"]);
    expect(clearAttention(dir, (item) => item.kind === "watcher")).toBe(1);
    expect(clearAttention(dir, () => true)).toBe(2);
    expect(listAttention(fresh())).toEqual([]);
    expect(attentionId("request", undefined, undefined)).toBe("request__none__any");
  });

  test("osc777 cleans the text", () => {
    expect(osc777("pi;git", "a\nb\x07c")).toBe("\x1b]777;notify;pi git;a b c\x07");
    expect(osc777("t", "x".repeat(400)).length).toBe("\x1b]777;notify;t;".length + 300 + 1);
  });
});

describe("notifyTerminals", () => {
  test("writes to the tty of every tmux client and refreshes its status line", async () => {
    const dir = fresh();
    const ttys = [join(dir, "tty1"), join(dir, "tty2")];
    for (const tty of ttys) writeFileSync(tty, "");
    const log = join(dir, "tmux.log");
    const tmux = join(dir, "tmux");
    writeFileSync(
      tmux,
      `#!/bin/sh\necho "$*" >> "${log}"\n[ "$1" = list-clients ] && printf '%s\\n%s\\n%s\\n' "${ttys[0]}" "${ttys[1]}" "${join(dir, "missing", "tty")}"\nexit 0\n`,
    );
    chmodSync(tmux, 0o755);
    const runner: Runner = (command, args, options) => run(command === "tmux" ? tmux : command, args, options);
    expect(await notifyTerminals(runner, "pi-git", "needs you", {})).toBe(2);
    expect(readFileSync(ttys[0] as string, "utf8")).toBe(osc777("pi-git", "needs you"));
    expect(readFileSync(log, "utf8")).toContain(`refresh-client -S -t ${ttys[1]}`);
  });

  test("off with PI_GIT_NO_NOTIFY, or without tmux", async () => {
    const never: Runner = async () => {
      throw new Error("should not run");
    };
    expect(await notifyTerminals(never, "t", "b", { PI_GIT_NO_NOTIFY: "1" })).toBe(0);
    const noServer: Runner = async () => ({ code: 1, stdout: "", stderr: "no server running" });
    expect(await notifyTerminals(noServer, "t", "b", {})).toBe(0);
  });
});
