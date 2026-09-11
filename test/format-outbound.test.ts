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

  test("leaves already-formatted usergroup mention tokens alone", () => {
    expect(formatOutboundSlackText("ping <!subteam^S12345678|@team>")).toBe(
      "ping <!subteam^S12345678|@team>",
    );
    expect(formatOutboundSlackText("ping <!subteam^S12345678>")).toBe("ping <!subteam^S12345678>");
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
    expect(formatOutboundSlackText("mail <mailto:bob@example.com|Bob>")).toBe(
      "mail <mailto:bob@example.com|Bob>",
    );
    expect(formatOutboundSlackText("see <https://a.test/?x=1&y=2>")).toBe(
      "see <https://a.test/?x=1&y=2>",
    );
  });

  test("converts inline Markdown links to Slack links", () => {
    expect(
      formatOutboundSlackText(
        "[MX-55362](https://meraki.atlassian.net/browse/MX-55362) | [PR #23229](https://github.com/net-plat-eng/dashboard-server/pull/23229)",
      ),
    ).toBe(
      "<https://meraki.atlassian.net/browse/MX-55362|MX-55362> | <https://github.com/net-plat-eng/dashboard-server/pull/23229|PR #23229>",
    );
  });

  test("preserves Markdown-like text in code, images, and escaped links", () => {
    const input =
      "`[code](https://example.com/code)` ![image](https://example.com/image.png) \\[escaped](https://example.com/escaped)";
    expect(formatOutboundSlackText(input)).toBe(input);
  });

  test("handles parenthesized link destinations and safely escapes labels", () => {
    expect(formatOutboundSlackText("[A & <B>](https://example.com/wiki/Foo_(bar)?x=1&y=2)")).toBe(
      "<https://example.com/wiki/Foo_(bar)?x=1&y=2|A &amp; &lt;B&gt;>",
    );
  });

  test("handles uppercase schemes and canonicalizes them for Slack", () => {
    expect(formatOutboundSlackText("[Example](HTTPS://E.TEST)")).toBe("<https://E.TEST|Example>");
  });

  test("handles escaped punctuation in link schemes", () => {
    expect(formatOutboundSlackText("[Example](https\\://e.test)")).toBe("<https://e.test|Example>");
  });

  test("handles escaped and nested brackets in link labels", () => {
    expect(formatOutboundSlackText("[A \\] [nested]](https://e.test)")).toBe(
      "<https://e.test|A ] [nested]>",
    );
  });

  test("preserves Markdown links inside multi-backtick code spans", () => {
    const input = "``foo ` [link](https://e.test)``";
    expect(formatOutboundSlackText(input)).toBe(input);
  });

  test("treats backtick runs preceded by a backslash as code-span closers", () => {
    const input = "``[link](https://e.test)\\``";
    expect(formatOutboundSlackText(input)).toBe(input);
  });

  test("matches protected URL schemes case-insensitively without accepting lowercase entity IDs", () => {
    expect(formatOutboundSlackText("<HTTPS://E.TEST|Example> <MAILTO:x@e.test|Email>")).toBe(
      "<HTTPS://E.TEST|Example> <MAILTO:x@e.test|Email>",
    );
    expect(formatOutboundSlackText("<@u123456a> <#c12345678> <!subteam^s12345678|@team>")).toBe(
      "&lt;@u123456a&gt; &lt;#c12345678&gt; &lt;!subteam^s12345678|@team&gt;",
    );
    expect(formatOutboundSlackText("<@U123456a> <#C123456a> <!subteam^S123456a|@team>")).toBe(
      "&lt;@U123456a&gt; &lt;#C123456a&gt; &lt;!subteam^S123456a|@team&gt;",
    );
  });

  test("handles bracket-heavy malformed input without repeated suffix scans", () => {
    const input = "[".repeat(40_000);
    const startedAt = performance.now();
    expect(formatOutboundSlackText(input)).toBe(input);
    expect(performance.now() - startedAt).toBeLessThan(500);
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
