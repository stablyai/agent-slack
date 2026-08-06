import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SlackApiClient } from "../src/slack/client.ts";
import { uploadFileForDraft, uploadLocalFileToSlack } from "../src/slack/upload.ts";

type Call = { method: string; params: Record<string, unknown> };

/**
 * Mock SlackApiClient that records every api() call and serves fixed
 * responses by method name. Mirrors the createClient helpers used in the
 * drafts/message-send test suites.
 */
function createClient(fixtures: Record<string, unknown>) {
  const calls: Call[] = [];
  const client = {
    api: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      return fixtures[method] ?? { ok: true };
    },
  } as unknown as SlackApiClient;
  return { client, calls };
}

function mockFetchOk() {
  const fetchMock = mock(async () => new Response("", { status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  return fetchMock;
}

describe("uploadFileForDraft", () => {
  let tempDir: string;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agent-slack-upload-test-"));
  });
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  });

  test("uploads bytes and returns the file id without binding to a channel", async () => {
    const { client, calls } = createClient({
      "files.getUploadURLExternal": {
        ok: true,
        upload_url: "https://upload.example/f",
        file_id: "F123",
      },
      "files.completeUploadExternal": {
        ok: true,
        files: [{ id: "F123", title: "img.png" }],
      },
    });
    const filePath = join(tempDir, "img.png");
    await writeFile(filePath, "png-bytes");
    const fetchMock = mockFetchOk();

    const fileId = await uploadFileForDraft({ client, filePath });

    expect(fileId).toBe("F123");
    expect(calls.map((c) => c.method)).toEqual([
      "files.getUploadURLExternal",
      "files.completeUploadExternal",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const complete = calls[1]!;
    expect(complete.params.files).toEqual([{ id: "F123", title: "img.png" }]);
    // A draft has no message yet — the completion call must not bind the file
    // to a channel, thread, or comment.
    expect(complete.params).not.toHaveProperty("channel_id");
    expect(complete.params).not.toHaveProperty("thread_ts");
    expect(complete.params).not.toHaveProperty("initial_comment");
  });

  test("throws and skips the upload when the path does not exist", async () => {
    const { client, calls } = createClient({});
    const fetchMock = mockFetchOk();

    await expect(
      uploadFileForDraft({ client, filePath: join(tempDir, "missing.png") }),
    ).rejects.toThrow();
    expect(calls.some((c) => c.method === "files.getUploadURLExternal")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("throws when the path is a directory", async () => {
    const { client } = createClient({});
    await mkdir(join(tempDir, "adir"));
    await expect(uploadFileForDraft({ client, filePath: join(tempDir, "adir") })).rejects.toThrow(
      /not a file/,
    );
  });

  test("throws when files.getUploadURLExternal fails", async () => {
    const { client } = createClient({
      "files.getUploadURLExternal": { ok: false, error: "ratelimited" },
    });
    const filePath = join(tempDir, "x.txt");
    await writeFile(filePath, "hi");
    mockFetchOk();

    await expect(uploadFileForDraft({ client, filePath })).rejects.toThrow(
      /getUploadURLExternal failed/,
    );
  });

  test("throws when the byte POST fails", async () => {
    const { client } = createClient({
      "files.getUploadURLExternal": {
        ok: true,
        upload_url: "https://upload.example/f",
        file_id: "F1",
      },
    });
    const filePath = join(tempDir, "x.txt");
    await writeFile(filePath, "hi");
    globalThis.fetch = mock(async () => new Response("err", { status: 500 })) as unknown as typeof fetch;

    await expect(uploadFileForDraft({ client, filePath })).rejects.toThrow(
      /Failed to upload attachment bytes/,
    );
  });

  test("throws when files.completeUploadExternal fails", async () => {
    const { client } = createClient({
      "files.getUploadURLExternal": {
        ok: true,
        upload_url: "https://upload.example/f",
        file_id: "F1",
      },
      "files.completeUploadExternal": { ok: false, error: "denied" },
    });
    const filePath = join(tempDir, "x.txt");
    await writeFile(filePath, "hi");
    mockFetchOk();

    await expect(uploadFileForDraft({ client, filePath })).rejects.toThrow(
      /completeUploadExternal failed/,
    );
  });
});

describe("uploadLocalFileToSlack (shared-helper regression)", () => {
  let tempDir: string;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agent-slack-upload-test-"));
  });
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  });

  test("still binds the completed file to a channel with an initial comment", async () => {
    const { client, calls } = createClient({
      "files.getUploadURLExternal": {
        ok: true,
        upload_url: "https://upload.example/f",
        file_id: "F1",
      },
    });
    const filePath = join(tempDir, "r.md");
    await writeFile(filePath, "# r\n");
    mockFetchOk();

    await uploadLocalFileToSlack({
      client,
      channelId: "C1",
      threadTs: "123.000100",
      initialComment: "hi",
      filePath,
    });

    const complete = calls[1]!;
    expect(complete.params.channel_id).toBe("C1");
    expect(complete.params.thread_ts).toBe("123.000100");
    expect(complete.params.initial_comment).toBe("hi");
  });
});
