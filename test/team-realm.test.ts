import { describe, expect, test } from "bun:test";
import { requireSingleSlackRealm, slackCookieHostCondition } from "../src/auth/team-realm.ts";

describe("browser credential realm pairing", () => {
  test("accepts teams from exactly one Slack realm", () => {
    expect(
      requireSingleSlackRealm([
        { url: "https://one.slack.com" },
        { url: "https://two.enterprise.slack.com" },
      ]),
    ).toBe("commercial");
    expect(requireSingleSlackRealm([{ url: "https://agency.slack-gov.com" }])).toBe("gov");
  });

  test("rejects a batch that would pair one cookie across Slack realms", () => {
    expect(() =>
      requireSingleSlackRealm([
        { url: "https://team.slack.com" },
        { url: "https://agency.slack-gov.com" },
      ]),
    ).toThrow("Cannot import Slack and GovSlack browser sessions together");
  });

  test("builds label-boundary cookie host conditions for one realm", () => {
    expect(slackCookieHostCondition("host_key", "commercial")).toBe(
      "(host_key = 'slack.com' or host_key like '%.slack.com')",
    );
    expect(slackCookieHostCondition("host", "gov")).toBe(
      "(host = 'slack-gov.com' or host like '%.slack-gov.com')",
    );
  });
});
