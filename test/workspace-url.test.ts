import { describe, expect, test } from "bun:test";
import { normalizeSlackWorkspaceUrl } from "../src/slack/workspace-url.ts";

describe("Slack workspace origins", () => {
  test("canonicalizes workspace and Enterprise Grid origins", () => {
    expect(normalizeSlackWorkspaceUrl("https://TEAM.slack.com/")).toBe("https://team.slack.com");
    expect(normalizeSlackWorkspaceUrl("https://acme.enterprise.slack.com")).toBe(
      "https://acme.enterprise.slack.com",
    );
  });

  test("rejects origins outside the Slack credential boundary", () => {
    for (const value of [
      "http://team.slack.com",
      "https://example.com",
      "https://team.slack.com.evil.test",
      "https://slack.com",
      "https://user:password@team.slack.com",
      "https://team.slack.com:8443",
      "https://team.slack.com/archives/C123",
      "https://team.slack.com?token=secret",
      "https://team.slack.com#fragment",
    ]) {
      expect(() => normalizeSlackWorkspaceUrl(value), value).toThrow(
        "canonical HTTPS Slack workspace origin",
      );
    }
  });
});
