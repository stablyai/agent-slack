import { describe, expect, test } from "bun:test";
import { htmlToMarkdown } from "../src/slack/html-to-md.ts";

describe("htmlToMarkdown", () => {
  test("converts basic HTML to markdown", () => {
    const md = htmlToMarkdown(
      '<html><body><h1>Title</h1><p>Hello <a href="https://example.com">world</a>.</p></body></html>',
    ).trim();
    expect(md).toContain("# Title");
    expect(md).toContain("Hello [world](https://example.com).");
  });
});
