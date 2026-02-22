import { describe, expect, test } from "bun:test";
import { parseMsgTarget } from "../src/cli/targets.ts";

describe("parseMsgTarget", () => {
  test("parses slack message URLs", () => {
    const t = parseMsgTarget(
      "https://stablygroup.slack.com/archives/C060RS20UMV/p1770165109628379",
    );
    expect(t.kind).toBe("url");
    if (t.kind !== "url") {
      throw new Error("expected url");
    }
    expect(t.ref.channel_id).toBe("C060RS20UMV");
    expect(t.ref.message_ts).toBe("1770165109.628379");
  });

  test("accepts #channel", () => {
    const t = parseMsgTarget("#general");
    expect(t.kind).toBe("channel");
    if (t.kind !== "channel") {
      throw new Error("expected channel");
    }
    expect(t.channel).toBe("#general");
  });

  test("accepts bare channel names", () => {
    const t = parseMsgTarget("general");
    expect(t.kind).toBe("channel");
    if (t.kind !== "channel") {
      throw new Error("expected channel");
    }
    expect(t.channel).toBe("#general");
  });

  test("accepts channel IDs", () => {
    const t = parseMsgTarget("C060RS20UMV");
    expect(t.kind).toBe("channel");
    if (t.kind !== "channel") {
      throw new Error("expected channel");
    }
    expect(t.channel).toBe("C060RS20UMV");
  });

  test("accepts user IDs as DM targets", () => {
    const t = parseMsgTarget("U12345ABCDE");
    expect(t.kind).toBe("user");
    if (t.kind !== "user") {
      throw new Error("expected user");
    }
    expect(t.userId).toBe("U12345ABCDE");
  });

  test("accepts user IDs with leading/trailing whitespace", () => {
    const t = parseMsgTarget("  U09GDJJKCCW  ");
    expect(t.kind).toBe("user");
    if (t.kind !== "user") {
      throw new Error("expected user");
    }
    expect(t.userId).toBe("U09GDJJKCCW");
  });

  test("does not treat short U-prefixed strings as user IDs", () => {
    const t = parseMsgTarget("U1234");
    expect(t.kind).toBe("channel");
  });

  test("accepts W-prefixed Enterprise Grid user IDs", () => {
    const t = parseMsgTarget("W12345ABCDE");
    expect(t.kind).toBe("user");
    if (t.kind !== "user") {
      throw new Error("expected user");
    }
    expect(t.userId).toBe("W12345ABCDE");
  });

  test("does not treat mixed-case U-prefixed strings as user IDs", () => {
    const t = parseMsgTarget("U12345abcde");
    expect(t.kind).toBe("channel");
  });
});
