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
});
