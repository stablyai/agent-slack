import { describe, expect, test } from "bun:test";
import { buildSlackMessageUrl, parseSlackMessageUrl } from "../src/slack/url.ts";

describe("parseSlackMessageUrl", () => {
  test("parses archives URL with p<digits>", () => {
    const ref = parseSlackMessageUrl(
      "https://stablygroup.slack.com/archives/C060RS20UMV/p1770165109628379",
    );
    expect(ref.workspace_url).toBe("https://stablygroup.slack.com");
    expect(ref.channel_id).toBe("C060RS20UMV");
    expect(ref.message_ts).toBe("1770165109.628379");
  });

  test("captures thread_ts from query when present", () => {
    const ref = parseSlackMessageUrl(
      "https://stablygroup.slack.com/archives/C060RS20UMV/p1770165109628379?thread_ts=1770160000.000001&cid=C060RS20UMV",
    );
    expect(ref.message_ts).toBe("1770165109.628379");
    expect(ref.thread_ts_hint).toBe("1770160000.000001");
  });
});

describe("buildSlackMessageUrl", () => {
  test("builds a permalink for a root message", () => {
    expect(
      buildSlackMessageUrl({
        workspace_url: "https://stablygroup.slack.com/",
        channel_id: "C060RS20UMV",
        message_ts: "1770165109.628379",
      }),
    ).toBe("https://stablygroup.slack.com/archives/C060RS20UMV/p1770165109628379");
  });

  test("includes thread metadata for replies", () => {
    expect(
      buildSlackMessageUrl({
        workspace_url: "https://stablygroup.slack.com",
        channel_id: "C060RS20UMV",
        message_ts: "1770165110.000001",
        thread_ts: "1770165109.628379",
      }),
    ).toBe(
      "https://stablygroup.slack.com/archives/C060RS20UMV/p1770165110000001?thread_ts=1770165109.628379&cid=C060RS20UMV",
    );
  });
});
