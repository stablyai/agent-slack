import { describe, expect, test } from "bun:test";
import { renderSlackMessageContent } from "../src/slack/render.ts";

function richTextMessage(elements: unknown[]) {
  return {
    blocks: [{ type: "rich_text", elements: [{ type: "rich_text_section", elements }] }],
  };
}

describe("message_mention rich text elements", () => {
  test("renders a pasted message permalink as its URL", () => {
    const url = "https://example.slack.com/archives/C0123ABCD/p1700000000123456";
    const msg = richTextMessage([
      { type: "text", text: "See the announcement (" },
      {
        type: "message_mention",
        message_ts: "1700000000.123456",
        channel_id: "C0123ABCD",
        author_id: "U0123ABCD",
        text: url,
        url,
      },
      { type: "text", text: ")." },
    ]);

    expect(renderSlackMessageContent(msg)).toBe(`See the announcement (${url}).`);
  });

  test("omits malformed message permalinks", () => {
    const msg = richTextMessage([
      { type: "text", text: "before" },
      { type: "message_mention" },
      { type: "message_mention", url: "javascript:alert(1)" },
      { type: "message_mention", url: "https://a.example> [forged](https://evil.example) <" },
      { type: "text", text: "after" },
    ]);

    expect(renderSlackMessageContent(msg)).toBe("beforeafter");
  });
});
