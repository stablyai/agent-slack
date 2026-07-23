import { describe, expect, test } from "bun:test";
import { parseSlackCanvasUrl } from "../src/slack/canvas.ts";
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

  test("parses Enterprise and GovSlack message URLs", () => {
    expect(
      parseSlackMessageUrl(
        "https://acme.enterprise.slack.com/archives/C060RS20UMV/p1770165109628379",
      ).workspace_url,
    ).toBe("https://acme.enterprise.slack.com");
    expect(
      parseSlackMessageUrl("https://agency.slack-gov.com/archives/C060RS20UMV/p1770165109628379")
        .workspace_url,
    ).toBe("https://agency.slack-gov.com");
  });

  test("rejects unsafe message URL origins", () => {
    const invalid = [
      "http://team.slack.com/archives/C060RS20UMV/p1770165109628379",
      "https://team.slack.com.evil.test/archives/C060RS20UMV/p1770165109628379",
      "https://user@team.slack.com/archives/C060RS20UMV/p1770165109628379",
      "https://team.slack.com:8443/archives/C060RS20UMV/p1770165109628379",
    ];

    for (const url of invalid) {
      expect(() => parseSlackMessageUrl(url), url).toThrow(
        "canonical HTTPS Slack or GovSlack origin",
      );
    }
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

  test("rejects an unsafe workspace origin", () => {
    expect(() =>
      buildSlackMessageUrl({
        workspace_url: "https://team.slack.com.evil.test",
        channel_id: "C060RS20UMV",
        message_ts: "1770165109.628379",
      }),
    ).toThrow("canonical HTTPS Slack or GovSlack origin");
  });
});

describe("parseSlackCanvasUrl", () => {
  test("parses a GovSlack canvas URL", () => {
    expect(
      parseSlackCanvasUrl("https://agency.slack-gov.com/docs/T12345678/F12345678"),
    ).toMatchObject({
      workspace_url: "https://agency.slack-gov.com",
      canvas_id: "F12345678",
    });
  });

  test("rejects unsafe canvas URL origins", () => {
    for (const url of [
      "http://team.slack.com/docs/T12345678/F12345678",
      "https://team.slack.com.evil.test/docs/T12345678/F12345678",
    ]) {
      expect(() => parseSlackCanvasUrl(url), url).toThrow(
        "canonical HTTPS Slack or GovSlack origin",
      );
    }
  });
});
