import { describe, expect, test } from "bun:test";
import { isUserId } from "../src/slack/user-id.ts";

describe("isUserId", () => {
  test("accepts U-prefixed and W-prefixed Slack user IDs", () => {
    expect(isUserId("U12345678")).toBe(true);
    expect(isUserId("W12345678")).toBe(true);
  });

  test("preserves the existing length and character restrictions", () => {
    expect(isUserId("U1234")).toBe(false);
    expect(isUserId("W1234")).toBe(false);
    expect(isUserId("B12345678")).toBe(false);
    expect(isUserId("w12345678")).toBe(false);
    expect(isUserId("W1234-678")).toBe(false);
  });
});
