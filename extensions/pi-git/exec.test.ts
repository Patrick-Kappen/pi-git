import { describe, expect, test } from "vitest";
import { clipEnd, clipStart, outputOf, run } from "./exec.ts";

describe("run", () => {
  test("exit code, output, stdin and environment", async () => {
    const result = await run("sh", ["-c", 'cat; echo "$X"; echo err >&2; exit 3'], {
      cwd: "/",
      input: "in\n",
      env: { X: "x" },
    });
    expect(result).toEqual({ code: 3, stdout: "in\nx\n", stderr: "err\n" });
  });

  test("timeout and abort", async () => {
    expect(await run("sleep", ["5"], { cwd: "/", timeoutMs: 100 })).toMatchObject({
      code: null,
      failure: "timed out after 0s",
    });
    const controller = new AbortController();
    const running = run("sleep", ["5"], { cwd: "/", signal: controller.signal });
    controller.abort();
    expect(await running).toMatchObject({ code: null, failure: "aborted" });
  });

  test("a command that does not exist", async () => {
    expect((await run("pi-git-no-such-command", [], { cwd: "/" })).failure).toMatch(/ENOENT/);
  });
});

describe("text", () => {
  test("outputOf", () => {
    expect(outputOf({ code: 1, stdout: " a \n", stderr: "b", failure: "timed out" })).toBe("a\nb\n(timed out)");
    expect(outputOf({ code: 0, stdout: "", stderr: "" })).toBe("");
  });

  test("clip", () => {
    expect(clipEnd("abcdef", 3)).toBe("[... 3 characters cut]\ndef");
    expect(clipStart("abcdef", 3)).toBe("abc\n[... 3 characters cut]");
    expect(clipEnd(" ab ", 3)).toBe("ab");
    expect(clipStart(" ab ", 3)).toBe("ab");
  });
});
