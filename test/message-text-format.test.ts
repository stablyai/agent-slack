import { describe, expect, test } from "bun:test";
import {
  formatMessagesText,
  parseOutputFormat,
  renderMessagePayload,
} from "../src/lib/message-text-format.ts";

describe("formatMessagesText", () => {
  test("prints one line per message with newlines collapsed", () => {
    const out = formatMessagesText([
      { ts: "1770165109.000001", author: { user_id: "U1" }, content: "hello\nworld\n\nbye" },
    ]);
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} U1 hello world bye$/);
  });

  test("prefers resolved names and marks replies", () => {
    const out = formatMessagesText(
      [
        { ts: "1.1", thread_ts: "1.0", author: { user_id: "U1" }, content: "re" },
        { ts: "1.0", thread_ts: "1.0", author: { bot_id: "B1" }, content: "root" },
      ],
      { U1: { id: "U1", display_name: "Ann" } },
    ).split("\n");
    expect(out[0]).toContain(" Ann [reply] re");
    expect(out[1]).toMatch(/ B1 root$/);
  });
});

describe("renderMessagePayload", () => {
  test("json stays the default shape", () => {
    const payload = { messages: [] };
    expect(renderMessagePayload(payload, "json")).toBe(JSON.stringify(payload, null, 2));
  });

  test("text handles single-message payloads", () => {
    const out = renderMessagePayload({ message: { ts: "1.0", content: "hi" } }, "text");
    expect(out).toMatch(/ unknown hi$/);
  });
});

describe("parseOutputFormat", () => {
  test("defaults to json and rejects unknown values", () => {
    expect(parseOutputFormat(undefined)).toBe("json");
    expect(parseOutputFormat("TEXT")).toBe("text");
    expect(() => parseOutputFormat("yaml")).toThrow("--format");
  });
});
