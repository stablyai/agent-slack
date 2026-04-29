import { describe, expect, test } from "bun:test";
import { formatOutboundSlackText } from "../src/slack/format-outbound.ts";

describe("formatOutboundSlackText", () => {
  test("promotes bare user IDs to Slack mention tokens", () => {
    expect(formatOutboundSlackText("@U05BRPTKL6A heads up")).toBe("<@U05BRPTKL6A> heads up");
    expect(formatOutboundSlackText("cc @W123456A and @BABCDEFG")).toBe(
      "cc <@W123456A> and <@BABCDEFG>",
    );
  });

  test("leaves already-formatted mention tokens alone", () => {
    expect(formatOutboundSlackText("hi <@U123456A>!")).toBe("hi <@U123456A>!");
    expect(formatOutboundSlackText("hi <@U123456A|nick>!")).toBe("hi <@U123456A|nick>!");
  });

  test("promotes broadcast mentions", () => {
    expect(formatOutboundSlackText("@here ping")).toBe("<!here> ping");
    expect(formatOutboundSlackText("cc @channel and @everyone")).toBe(
      "cc <!channel> and <!everyone>",
    );
  });

  test("escapes bare < > & in literal text", () => {
    expect(formatOutboundSlackText("a < b && c > d")).toBe("a &lt; b &amp;&amp; c &gt; d");
  });

  test("does not escape inside already-formatted Slack tokens", () => {
    expect(formatOutboundSlackText("see <https://example.com|link>")).toBe(
      "see <https://example.com|link>",
    );
    expect(formatOutboundSlackText("see <https://a.test/?x=1&y=2>")).toBe(
      "see <https://a.test/?x=1&y=2>",
    );
  });

  test("does not promote email-like or mid-word @", () => {
    expect(formatOutboundSlackText("mail me at user@Udomain.com")).toBe(
      "mail me at user@Udomain.com",
    );
  });

  test("handles empty input", () => {
    expect(formatOutboundSlackText("")).toBe("");
  });

  test("real-world CI dump stays readable with mention + URL", () => {
    const input =
      '@U05BRPTKL6A heads up: CI "Install dependencies" is failing: https://github.com/x/y/actions/runs/1 & it needs <fix>';
    expect(formatOutboundSlackText(input)).toBe(
      '<@U05BRPTKL6A> heads up: CI "Install dependencies" is failing: https://github.com/x/y/actions/runs/1 &amp; it needs &lt;fix&gt;',
    );
  });
});
