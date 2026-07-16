import { describe, expect, test } from "bun:test";
import { parseInlineElements, textToRichTextBlocks } from "../src/slack/rich-text.ts";

describe("parseInlineElements", () => {
  test("plain text returns single text element", () => {
    expect(parseInlineElements("Hello world")).toEqual([{ type: "text", text: "Hello world" }]);
  });

  test("*bold* is parsed with bold style", () => {
    expect(parseInlineElements("Hello *world*!")).toEqual([
      { type: "text", text: "Hello " },
      { type: "text", text: "world", style: { bold: true } },
      { type: "text", text: "!" },
    ]);
  });

  test("_italic_ is parsed with italic style", () => {
    expect(parseInlineElements("This is _important_")).toEqual([
      { type: "text", text: "This is " },
      { type: "text", text: "important", style: { italic: true } },
    ]);
  });

  test("~strike~ is parsed with strike style", () => {
    expect(parseInlineElements("~done~")).toEqual([
      { type: "text", text: "done", style: { strike: true } },
    ]);
  });

  test("`code` is parsed with code style", () => {
    expect(parseInlineElements("Run `npm install`")).toEqual([
      { type: "text", text: "Run " },
      { type: "text", text: "npm install", style: { code: true } },
    ]);
  });

  test(":emoji: shortcode is parsed as an emoji element", () => {
    expect(parseInlineElements("Launch :rocket: now")).toEqual([
      { type: "text", text: "Launch " },
      { type: "emoji", name: "rocket" },
      { type: "text", text: " now" },
    ]);
  });

  test("emoji names with underscores are not parsed as italic text", () => {
    expect(parseInlineElements(":white_check_mark: all clear")).toEqual([
      { type: "emoji", name: "white_check_mark" },
      { type: "text", text: " all clear" },
    ]);
  });

  test("time-like colon text is not parsed as an emoji element", () => {
    expect(parseInlineElements("Time 12:30:00")).toEqual([{ type: "text", text: "Time 12:30:00" }]);
  });

  test("<url|label> is parsed as link with text", () => {
    expect(parseInlineElements("Visit <https://example.com|Example>")).toEqual([
      { type: "text", text: "Visit " },
      { type: "link", url: "https://example.com", text: "Example" },
    ]);
  });

  test("<url> is parsed as link without text", () => {
    expect(parseInlineElements("See <https://example.com>")).toEqual([
      { type: "text", text: "See " },
      { type: "link", url: "https://example.com" },
    ]);
  });

  test("<mailto|label> is parsed as link with text", () => {
    expect(parseInlineElements("Email <mailto:bob@example.com|Bob>")).toEqual([
      { type: "text", text: "Email " },
      { type: "link", url: "mailto:bob@example.com", text: "Bob" },
    ]);
  });

  test("non-url angle bracket text is preserved as text", () => {
    expect(parseInlineElements("Use <fix>")).toEqual([
      { type: "text", text: "Use " },
      { type: "text", text: "<fix>" },
    ]);
  });

  test("non-url labeled angle bracket text is preserved as text", () => {
    expect(parseInlineElements("Use <fix|label>")).toEqual([
      { type: "text", text: "Use " },
      { type: "text", text: "<fix|label>" },
    ]);
  });

  test("channel mention tokens are parsed as channel elements", () => {
    expect(parseInlineElements("See <#C12345678|general>")).toEqual([
      { type: "text", text: "See " },
      { type: "channel", channel_id: "C12345678" },
    ]);
  });

  test("bare channel mention tokens are parsed as channel elements", () => {
    expect(parseInlineElements("See <#C12345678>")).toEqual([
      { type: "text", text: "See " },
      { type: "channel", channel_id: "C12345678" },
    ]);
  });

  test("usergroup mention tokens are parsed as usergroup elements", () => {
    expect(parseInlineElements("Ping <!subteam^S12345678|@team>")).toEqual([
      { type: "text", text: "Ping " },
      { type: "usergroup", usergroup_id: "S12345678" },
    ]);
  });
});

describe("textToRichTextBlocks", () => {
  test("plain text returns null", () => {
    expect(textToRichTextBlocks("Hello world")).toBeNull();
  });

  test("inline-only formatting returns null by default", () => {
    expect(textToRichTextBlocks("Visit <https://example.com|Example>")).toBeNull();
  });

  test("non-url angle bracket text does not trigger rich text blocks", () => {
    expect(textToRichTextBlocks("Use <fix>", { includeInlineFormatting: true })).toBeNull();
    expect(textToRichTextBlocks("Use <fix|label>", { includeInlineFormatting: true })).toBeNull();
  });

  test("mixed non-url angle bracket text and formatting preserves brackets", () => {
    const result = textToRichTextBlocks("Use <fix|label> and *bold*", {
      includeInlineFormatting: true,
    })!;
    expect(result[0]!.elements).toEqual([
      {
        type: "rich_text_section",
        elements: [
          { type: "text", text: "Use " },
          { type: "text", text: "<fix|label>" },
          { type: "text", text: " and " },
          { type: "text", text: "bold", style: { bold: true } },
          { type: "text", text: "\n" },
        ],
      },
    ]);
  });

  test("inline-only formatting can produce rich text blocks", () => {
    const result = textToRichTextBlocks("Visit <https://example.com|Example>", {
      includeInlineFormatting: true,
    })!;
    expect(result).not.toBeNull();
    expect(result[0]!.elements).toEqual([
      {
        type: "rich_text_section",
        elements: [
          { type: "text", text: "Visit " },
          { type: "link", url: "https://example.com", text: "Example" },
          { type: "text", text: "\n" },
        ],
      },
    ]);
  });

  test("mailto links can produce rich text blocks when inline formatting is included", () => {
    const result = textToRichTextBlocks("Email <mailto:bob@example.com|Bob>", {
      includeInlineFormatting: true,
    })!;
    expect(result).not.toBeNull();
    expect(result[0]!.elements).toEqual([
      {
        type: "rich_text_section",
        elements: [
          { type: "text", text: "Email " },
          { type: "link", url: "mailto:bob@example.com", text: "Bob" },
          { type: "text", text: "\n" },
        ],
      },
    ]);
  });

  test("channel mentions can produce rich text blocks when inline formatting is included", () => {
    const result = textToRichTextBlocks("See <#C12345678|general>", {
      includeInlineFormatting: true,
    })!;
    expect(result).not.toBeNull();
    expect(result[0]!.elements).toEqual([
      {
        type: "rich_text_section",
        elements: [
          { type: "text", text: "See " },
          { type: "channel", channel_id: "C12345678" },
          { type: "text", text: "\n" },
        ],
      },
    ]);
  });

  test("bullet list with - prefix", () => {
    const result = textToRichTextBlocks("- Item 1\n- Item 2\n- Item 3")!;
    expect(result).not.toBeNull();
    const lists = result[0]!.elements.filter((e) => e.type === "rich_text_list");
    expect(lists).toHaveLength(1);
    const list = lists[0]!;
    expect(list.type === "rich_text_list" && list.elements).toHaveLength(3);
  });

  test("bullet list with bullet character", () => {
    expect(textToRichTextBlocks("• Item 1\n• Item 2")).not.toBeNull();
  });

  test("sub-bullets with indentation", () => {
    const result = textToRichTextBlocks("- Main 1\n- Main 2\n  - Sub 2a\n  - Sub 2b\n- Main 3")!;
    expect(result).not.toBeNull();
    const lists = result[0]!.elements.filter((e) => e.type === "rich_text_list");
    expect(lists).toHaveLength(3); // main, sub, main
    expect((lists[1] as { indent?: number }).indent).toBe(1);
  });

  test("white bullet sub-bullets under bullet", () => {
    const result = textToRichTextBlocks("• Top level\n  ◦ Sub-bullet\n  ◦ Another sub")!;
    expect(result).not.toBeNull();
    const lists = result[0]!.elements.filter((e) => e.type === "rich_text_list");
    expect(lists).toHaveLength(2);
    expect((lists[1] as { indent?: number }).indent).toBe(1);
  });

  test("mixed text and bullets", () => {
    const result = textToRichTextBlocks("Here is a list:\n- Item 1\n- Item 2")!;
    expect(result).not.toBeNull();
    expect(result[0]!.elements[0]!.type).toBe("rich_text_section");
    expect(result[0]!.elements[1]!.type).toBe("rich_text_list");
  });

  test("numbered list", () => {
    const result = textToRichTextBlocks("1. First\n2. Second\n3. Third")!;
    expect(result).not.toBeNull();
    const list = result[0]!.elements.find((e) => e.type === "rich_text_list")!;
    expect((list as { style: string }).style).toBe("ordered");
  });

  test("bold text in list items is parsed", () => {
    const result = textToRichTextBlocks("- *Bold item*\n- Normal item")!;
    expect(result).not.toBeNull();
    const list = result[0]!.elements.find((e) => e.type === "rich_text_list") as {
      elements: { elements: unknown[] }[];
    };
    expect(list.elements[0]!.elements).toEqual([
      { type: "text", text: "Bold item", style: { bold: true } },
    ]);
  });

  test("emoji and channel references in list items are parsed", () => {
    const result = textToRichTextBlocks(
      "Header:\n- :rocket: launch sequence\n- discuss in <#C0AHR9XAT8B>\n- :white_check_mark: all clear",
    )!;
    expect(result).not.toBeNull();
    const list = result[0]!.elements.find((e) => e.type === "rich_text_list") as {
      elements: { elements: unknown[] }[];
    };
    expect(list.elements[0]!.elements).toEqual([
      { type: "emoji", name: "rocket" },
      { type: "text", text: " launch sequence" },
    ]);
    expect(list.elements[1]!.elements).toEqual([
      { type: "text", text: "discuss in " },
      { type: "channel", channel_id: "C0AHR9XAT8B" },
    ]);
    expect(list.elements[2]!.elements).toEqual([
      { type: "emoji", name: "white_check_mark" },
      { type: "text", text: " all clear" },
    ]);
  });

  test("Slack manual links and CommonMark links remain distinct in list items", () => {
    const result = textToRichTextBlocks(
      "- Review <https://example.com/pull/42|PR #42>\n- Review [PR #43](https://example.com/pull/43)",
    )!;
    const list = result[0]!.elements.find((e) => e.type === "rich_text_list") as {
      elements: { elements: unknown[] }[];
    };
    expect(list.elements[0]!.elements).toEqual([
      { type: "text", text: "Review " },
      { type: "link", url: "https://example.com/pull/42", text: "PR #42" },
    ]);
    expect(list.elements[1]!.elements).toEqual([
      { type: "text", text: "Review [PR #43](https://example.com/pull/43)" },
    ]);
  });

  test("code block is preserved", () => {
    const result = textToRichTextBlocks("- Item\n```\ncode here\n```")!;
    expect(result).not.toBeNull();
    expect(result[0]!.elements.find((e) => e.type === "rich_text_preformatted")).toBeDefined();
  });

  test("blockquote is preserved", () => {
    const result = textToRichTextBlocks("- Item\n> quoted text")!;
    expect(result).not.toBeNull();
    expect(result[0]!.elements.find((e) => e.type === "rich_text_quote")).toBeDefined();
  });
});
