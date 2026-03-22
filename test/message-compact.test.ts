import { describe, expect, test } from "bun:test";
import { toCompactMessage } from "../src/slack/message-compact.ts";
import { passesContentTypeFilter } from "../src/slack/search-messages.ts";
import type { SlackMessageSummary } from "../src/slack/messages.ts";
import type { DownloadResult } from "../src/slack/files.ts";

function makeMessage(files?: SlackMessageSummary["files"]): SlackMessageSummary {
  return {
    channel_id: "C123",
    ts: "1234567890.000001",
    text: "hello",
    markdown: "hello",
    files,
  };
}

describe("toCompactMessage", () => {
  test("includes file with path on successful download", () => {
    const msg = makeMessage([
      {
        id: "F1",
        name: "diagram.png",
        mimetype: "image/png",
        url_private: "https://example.com/f1",
      },
    ]);
    const downloadedPaths: Record<string, DownloadResult> = {
      F1: { ok: true, path: "/tmp/F1.png" },
    };
    const compact = toCompactMessage(msg, { downloadedPaths });
    expect(compact.files).toHaveLength(1);
    expect(compact.files![0]).toMatchObject({
      name: "diagram.png",
      mimetype: "image/png",
      path: "/tmp/F1.png",
    });
  });

  test("includes file with error on failed download", () => {
    const msg = makeMessage([
      {
        id: "F1",
        name: "diagram.png",
        mimetype: "image/png",
        url_private: "https://example.com/f1",
      },
    ]);
    const downloadedPaths: Record<string, DownloadResult> = {
      F1: {
        ok: false,
        error: "Failed to download file (404)",
        httpStatus: 404,
        path: "/tmp/F1.download-error.txt",
      },
    };
    const compact = toCompactMessage(msg, { downloadedPaths });
    expect(compact.files).toHaveLength(1);
    expect(compact.files![0]).toMatchObject({
      name: "diagram.png",
      mimetype: "image/png",
      path: "/tmp/F1.download-error.txt",
      error: "Failed to download file (404)",
    });
  });

  test("excludes files with no downloadedPaths entry", () => {
    const msg = makeMessage([
      { id: "F1", mimetype: "image/png", url_private: "https://example.com/f1" },
    ]);
    const compact = toCompactMessage(msg, { downloadedPaths: {} });
    expect(compact.files).toBeUndefined();
  });

  test("mixes successful and failed downloads", () => {
    const msg = makeMessage([
      {
        id: "F1",
        name: "diagram.png",
        mimetype: "image/png",
        url_private: "https://example.com/f1",
      },
      { id: "F2", mimetype: "text/plain", mode: "snippet", url_private: "https://example.com/f2" },
    ]);
    const downloadedPaths: Record<string, DownloadResult> = {
      F1: { ok: true, path: "/tmp/F1.png" },
      F2: {
        ok: false,
        error: "Failed to download file (401)",
        httpStatus: 401,
        path: "/tmp/F2.download-error.txt",
      },
    };
    const compact = toCompactMessage(msg, { downloadedPaths });
    expect(compact.files).toHaveLength(2);
    expect(compact.files![0]).toMatchObject({
      name: "diagram.png",
      mimetype: "image/png",
      path: "/tmp/F1.png",
    });
    expect(compact.files![1]).toMatchObject({
      mimetype: "text/plain",
      mode: "snippet",
      path: "/tmp/F2.download-error.txt",
      error: "Failed to download file (401)",
    });
  });

  test("failed download preserves file metadata for content-type filtering", () => {
    const msg = makeMessage([
      { id: "F1", mimetype: "image/png", url_private: "https://example.com/f1" },
    ]);
    const downloadedPaths: Record<string, DownloadResult> = {
      F1: {
        ok: false,
        error: "Failed to download file (404)",
        httpStatus: 404,
        path: "/tmp/F1.download-error.txt",
      },
    };
    const compact = toCompactMessage(msg, { downloadedPaths });
    expect(compact.files).toHaveLength(1);
    expect(compact.files![0]!.mimetype).toBe("image/png");
  });
});

describe("passesContentTypeFilter with failed downloads", () => {
  test("image message with failed download still passes image filter", () => {
    const msg = makeMessage([
      { id: "F1", mimetype: "image/png", url_private: "https://example.com/f1" },
    ]);
    const downloadedPaths: Record<string, DownloadResult> = {
      F1: {
        ok: false,
        error: "Failed to download file (404)",
        httpStatus: 404,
        path: "/tmp/F1.download-error.txt",
      },
    };
    const compact = toCompactMessage(msg, { downloadedPaths });
    expect(passesContentTypeFilter(compact, "image")).toBe(true);
    expect(passesContentTypeFilter(compact, "file")).toBe(true);
    expect(passesContentTypeFilter(compact, "text")).toBe(false);
  });

  test("snippet message with failed download still passes snippet filter", () => {
    const msg = makeMessage([
      { id: "F1", mimetype: "text/plain", mode: "snippet", url_private: "https://example.com/f1" },
    ]);
    const downloadedPaths: Record<string, DownloadResult> = {
      F1: {
        ok: false,
        error: "Failed to download file (401)",
        httpStatus: 401,
        path: "/tmp/F1.download-error.txt",
      },
    };
    const compact = toCompactMessage(msg, { downloadedPaths });
    expect(passesContentTypeFilter(compact, "snippet")).toBe(true);
    expect(passesContentTypeFilter(compact, "file")).toBe(true);
  });

  test("message without download entry has no files and passes text filter", () => {
    const msg = makeMessage([
      { id: "F1", mimetype: "image/png", url_private: "https://example.com/f1" },
    ]);
    const compact = toCompactMessage(msg, { downloadedPaths: {} });
    expect(passesContentTypeFilter(compact, "text")).toBe(true);
    expect(passesContentTypeFilter(compact, "image")).toBe(false);
  });
});

describe("toCompactMessage filename preservation", () => {
  test("does not fall back to title when name is missing", () => {
    const msg = makeMessage([{ id: "F2", title: "My Document", mimetype: "text/plain" }]);
    const downloadedPaths: Record<string, DownloadResult> = {
      F2: { ok: true, path: "/tmp/F2/doc.txt" },
    };
    const compact = toCompactMessage(msg, { downloadedPaths });
    expect(compact.files).toHaveLength(1);
    expect(compact.files![0]).toMatchObject({
      name: undefined,
      mimetype: "text/plain",
      path: "/tmp/F2/doc.txt",
    });
  });
});
