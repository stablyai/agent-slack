import { describe, expect, test } from "bun:test";
import { looksLikeAuthPage } from "../src/slack/files.ts";

describe("looksLikeAuthPage", () => {
  test("detects traditional form-based signin page", () => {
    expect(looksLikeAuthPage('<form action="/signin" method="post">')).toBe(true);
  });

  test("detects data-qa signin attribute", () => {
    expect(looksLikeAuthPage('<div data-qa="signin"></div>')).toBe(true);
  });

  test("detects Sign in title", () => {
    expect(looksLikeAuthPage("<title>Sign in - Slack</title>")).toBe(true);
    expect(looksLikeAuthPage("<title>Signin</title>")).toBe(true);
  });

  test("detects React-based Slack login with shouldRedirect", () => {
    const reactLoginHtml =
      '{"shouldRedirect":true,"redirectURL":"/files-pri/T01234/F56789"}';
    expect(looksLikeAuthPage(reactLoginHtml)).toBe(true);
  });

  test("detects redirectURL pointing to files-pri", () => {
    const html = '<script>{"redirectURL":"\\/files-pri\\/something"}</script>';
    expect(looksLikeAuthPage(html)).toBe(true);
  });

  test("does not flag normal canvas HTML content", () => {
    const canvasHtml =
      "<html><body><h1>Meeting Notes</h1><p>Action items for Q4</p></body></html>";
    expect(looksLikeAuthPage(canvasHtml)).toBe(false);
  });

  test("does not flag plain text content", () => {
    expect(looksLikeAuthPage("Hello world, this is a transcript.")).toBe(false);
  });
});
