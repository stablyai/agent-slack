import { describe, expect, test } from "bun:test";
import { toCompactMessage } from "../src/slack/message-compact.ts";
import type { SlackMessageSummary } from "../src/slack/messages.ts";

function makeMsg(overrides: Partial<SlackMessageSummary> = {}): SlackMessageSummary {
  return {
    channel_id: "C123",
    ts: "1700000000.000000",
    text: "",
    markdown: "",
    blocks: [],
    attachments: [],
    ...overrides,
  };
}

describe("toCompactMessage files", () => {
  test("includes name from f.name when present", () => {
    const msg = makeMsg({
      files: [{ id: "F1", name: "report.pdf", title: "Q4 Report", mimetype: "application/pdf" }],
    });
    const result = toCompactMessage(msg, { downloadedPaths: { F1: "/tmp/F1/report.pdf" } });
    expect(result.files).toEqual([
      {
        name: "report.pdf",
        mimetype: "application/pdf",
        mode: undefined,
        path: "/tmp/F1/report.pdf",
      },
    ]);
  });

  test("does not fall back to title when name is missing", () => {
    const msg = makeMsg({
      files: [{ id: "F2", title: "My Document", mimetype: "text/plain" }],
    });
    const result = toCompactMessage(msg, { downloadedPaths: { F2: "/tmp/F2/doc.txt" } });
    expect(result.files).toEqual([
      { name: undefined, mimetype: "text/plain", mode: undefined, path: "/tmp/F2/doc.txt" },
    ]);
  });

  test("omits files without a download path", () => {
    const msg = makeMsg({
      files: [{ id: "F3", name: "photo.jpg", mimetype: "image/jpeg" }],
    });
    const result = toCompactMessage(msg, { downloadedPaths: {} });
    expect(result.files).toBeUndefined();
  });
});
