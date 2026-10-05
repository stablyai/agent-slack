import { describe, expect, test } from "bun:test";
import { extractMrkdwnFromRichTextBlock } from "../src/slack/render-rich-text.ts";
import { textToRichTextBlocks } from "../src/slack/rich-text.ts";

describe("extractMrkdwnFromRichTextBlock", () => {
  test("continues ordered numbering from the list offset", () => {
    const block = {
      type: "rich_text",
      elements: [
        {
          type: "rich_text_list",
          style: "ordered",
          offset: 2,
          elements: [
            { type: "rich_text_section", elements: [{ type: "text", text: "Third" }] },
            { type: "rich_text_section", elements: [{ type: "text", text: "Fourth" }] },
          ],
        },
      ],
    };
    expect(extractMrkdwnFromRichTextBlock(block)).toBe("3. Third\n4. Fourth");
  });

  test("indents nested bullet lists", () => {
    const block = {
      type: "rich_text",
      elements: [
        {
          type: "rich_text_list",
          style: "bullet",
          indent: 1,
          elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "Detail" }] }],
        },
      ],
    };
    expect(extractMrkdwnFromRichTextBlock(block)).toBe("  - Detail");
  });

  test("round-trips ordered numbering and nested indentation", () => {
    const text = "1. First\n  - Detail\n2. Second";
    const blocks = textToRichTextBlocks(text)!;
    expect(extractMrkdwnFromRichTextBlock(blocks[0])).toBe(text);
  });
});
