import { describe, expect, test } from "vitest";
import { extractJson, stringField } from "./json.ts";

describe("extractJson", () => {
  test.each([
    ['{"a": 1}', { a: 1 }],
    ['Here it is: {"a": {"b": 2}} done', { a: { b: 2 } }],
    ['```json\n{"a": "x"}\n```', { a: "x" }],
    ['```\n{"a": "x"}\n```', { a: "x" }],
  ])("%s", (text, value) => {
    expect(extractJson(text)).toEqual(value);
  });

  test("no object", () => {
    expect(() => extractJson("nothing")).toThrow("no JSON object");
    expect(() => extractJson("{broken")).toThrow("no JSON object");
    expect(() => extractJson("{broken}")).toThrow();
  });
});

describe("stringField", () => {
  test("values and errors", () => {
    expect(stringField({ a: " x " }, "a")).toBe("x");
    expect(stringField({}, "a", true)).toBe("");
    expect(stringField({ a: "" }, "a", true)).toBe("");
    expect(stringField({ a: "" }, "a")).toEqual(new Error('"a" must be a non-empty string'));
    expect(stringField({ a: 1 }, "a")).toEqual(new Error('"a" must be a non-empty string'));
    expect(stringField([], "a")).toEqual(new Error("expected a JSON object"));
  });
});
