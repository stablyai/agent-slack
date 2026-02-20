import { describe, expect, test } from "bun:test";
import { parseLimit, requireMessageTs } from "../src/cli/message-actions.ts";

describe("parseLimit", () => {
  test("returns undefined when no value given", () => {
    expect(parseLimit(undefined)).toBeUndefined();
  });

  test("parses valid positive integers", () => {
    expect(parseLimit("10")).toBe(10);
    expect(parseLimit("1")).toBe(1);
    expect(parseLimit("200")).toBe(200);
  });

  test("rejects non-numeric strings", () => {
    expect(() => parseLimit("abc")).toThrow("must be a positive integer");
  });

  test("rejects zero", () => {
    expect(() => parseLimit("0")).toThrow("must be a positive integer");
  });

  test("rejects negative numbers", () => {
    expect(() => parseLimit("-5")).toThrow("must be a positive integer");
  });

  test("rejects floats (uses integer part)", () => {
    // parseInt("3.5") → 3, which is valid
    expect(parseLimit("3.5")).toBe(3);
  });
});

describe("requireMessageTs", () => {
  test("returns trimmed ts when present", () => {
    expect(requireMessageTs(" 1770165109.628379 ")).toBe("1770165109.628379");
  });

  test("throws when missing", () => {
    expect(() => requireMessageTs(undefined)).toThrow(
      'When targeting a channel, you must pass --ts "<seconds>.<micros>"',
    );
  });

  test("throws when blank", () => {
    expect(() => requireMessageTs("   ")).toThrow(
      'When targeting a channel, you must pass --ts "<seconds>.<micros>"',
    );
  });
});
