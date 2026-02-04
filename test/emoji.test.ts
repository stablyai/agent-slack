import { describe, expect, test } from "bun:test";
import { normalizeSlackReactionName } from "../src/slack/emoji.ts";

describe("normalizeSlackReactionName", () => {
  test("accepts :shortcode:", () => {
    expect(normalizeSlackReactionName(":rocket:")).toBe("rocket");
    expect(normalizeSlackReactionName(":+1:")).toBe("+1");
  });

  test("accepts raw names", () => {
    expect(normalizeSlackReactionName("rocket")).toBe("rocket");
    expect(normalizeSlackReactionName("+1")).toBe("+1");
    expect(normalizeSlackReactionName("white_check_mark")).toBe("white_check_mark");
  });

  test("accepts unicode emoji", () => {
    expect(normalizeSlackReactionName("🚀")).toBe("rocket");
  });
});
