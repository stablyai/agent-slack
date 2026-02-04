import { describe, expect, test } from "bun:test";
import { pruneEmpty } from "../src/lib/compact-json.ts";

describe("pruneEmpty", () => {
  test("drops null/undefined/empty containers", () => {
    const input: Record<string, unknown> = {
      a: null,
      b: undefined,
      c: "",
      d: "ok",
      e: [],
      f: {},
      g: { x: "", y: 1 },
      h: [null, "", 2, { z: "" }, { z: "a" }],
    };
    expect(pruneEmpty(input)).toEqual({
      d: "ok",
      g: { y: 1 },
      h: [2, { z: "a" }],
    });
  });
});
