import { describe, expect, test } from "vitest";
import { greet } from "./index.ts";

describe("greet", () => {
  test("greets by name", () => {
    expect(greet(" Ada ")).toBe("Hello, Ada!");
  });

  test("greets the world without a name", () => {
    expect(greet("  ")).toBe("Hello, world!");
  });
});
