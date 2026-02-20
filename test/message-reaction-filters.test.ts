import { describe, expect, test } from "bun:test";
import {
  parseReactionFilters,
  requireOldestWhenReactionFiltersUsed,
} from "../src/cli/message-actions.ts";
import { passesReactionNameFilters } from "../src/slack/messages.ts";

describe("parseReactionFilters", () => {
  test("normalizes shortcodes, names, and unicode", () => {
    const out = parseReactionFilters([":dart:", "dart", "🎯"]);
    expect(out).toEqual(["dart"]);
  });

  test("returns empty array when unset", () => {
    expect(parseReactionFilters(undefined)).toEqual([]);
  });
});

describe("passesReactionNameFilters", () => {
  test("matches when required reaction is present", () => {
    const msg = { reactions: [{ name: "dart" }] } as Record<string, unknown>;
    expect(passesReactionNameFilters(msg, { withReactions: ["dart"] })).toBe(true);
  });

  test("does not match when required reaction is missing", () => {
    const msg = { reactions: [{ name: "eyes" }] } as Record<string, unknown>;
    expect(passesReactionNameFilters(msg, { withReactions: ["dart"] })).toBe(false);
  });

  test("does not match when excluded reaction is present", () => {
    const msg = { reactions: [{ name: "dart" }] } as Record<string, unknown>;
    expect(passesReactionNameFilters(msg, { withoutReactions: ["dart"] })).toBe(false);
  });

  test("matches when excluded reaction is absent", () => {
    const msg = { reactions: [{ name: "eyes" }] } as Record<string, unknown>;
    expect(passesReactionNameFilters(msg, { withoutReactions: ["dart"] })).toBe(true);
  });

  test("supports with + without together", () => {
    const msg = { reactions: [{ name: "eyes" }, { name: "white_check_mark" }] } as Record<
      string,
      unknown
    >;
    expect(
      passesReactionNameFilters(msg, {
        withReactions: ["eyes"],
        withoutReactions: ["dart"],
      }),
    ).toBe(true);
  });
});

describe("requireOldestWhenReactionFiltersUsed", () => {
  test("returns oldest when no reaction filters are used", () => {
    expect(
      requireOldestWhenReactionFiltersUsed({
        oldest: undefined,
        withReactions: [],
        withoutReactions: [],
      }),
    ).toBeUndefined();
  });

  test("returns trimmed oldest when reaction filters are used", () => {
    expect(
      requireOldestWhenReactionFiltersUsed({
        oldest: " 1770165109.628379 ",
        withReactions: ["dart"],
        withoutReactions: [],
      }),
    ).toBe("1770165109.628379");
  });

  test("throws when reaction filters are used without oldest", () => {
    expect(() =>
      requireOldestWhenReactionFiltersUsed({
        oldest: undefined,
        withReactions: ["dart"],
        withoutReactions: [],
      }),
    ).toThrow('Reaction filters require --oldest "<seconds>.<micros>" to bound scan size.');
  });
});
