import { describe, expect, test } from "bun:test";
import { slackMrkdwnToMarkdown } from "../src/slack/mrkdwn.ts";

describe("slackMrkdwnToMarkdown", () => {
  test("converts Slack-style links", () => {
    expect(slackMrkdwnToMarkdown("See <https://example.com|this>.")).toBe(
      "See [this](https://example.com).",
    );
    expect(slackMrkdwnToMarkdown("See <https://example.com>.")).toBe(
      "See https://example.com.",
    );
  });

  test("converts user and channel mentions", () => {
    expect(slackMrkdwnToMarkdown("Hi <@U12345> in <#C1|general>")).toBe(
      "Hi @U12345 in #general",
    );
    expect(slackMrkdwnToMarkdown("Hi <@U12345|nick>")).toBe("Hi @nick");
  });
});
