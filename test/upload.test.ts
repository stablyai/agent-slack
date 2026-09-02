import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SlackApiClient } from "../src/slack/client.ts";
import { uploadFilesForDraft, uploadLocalFileToSlack } from "../src/slack/upload.ts";

type Call = { method: string; params: Record<string, unknown> };

/**
 * Mock SlackApiClient that records every api() call and serves fixed
 * responses by method name. Mirrors the createClient helpers used in the
 * drafts/message-send test suites.
 */
type ApiFixture =
  | ((params: Record<string, unknown>) => unknown)
  | Record<string, unknown>
  | undefined;

function createClient(fixtures: Record<string, ApiFixture>) {
  const calls: Call[] = [];
  const client = {
    api: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      const fixture = fixtures[method];
      return typeof fixture === "function" ? fixture(params) : (fixture ?? { ok: true });
    },
  } as unknown as SlackApiClient;
  return { client, calls };
}

/** Mock the byte-upload POST as HTTP 200. */
function mockFetchOk() {
  const fetchMock = mock(async () => new Response("", { status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  return fetchMock;
}

function completeCalls(calls: Call[]): Call[] {
  return calls.filter((c) => c.method === "files.completeUploadExternal");
}

describe("uploadFilesForDraft", () => {
  let tempDir: string;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agent-slack-upload-test-"));
  });
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  });

  test("never shifts ids between files when the completion response omits one", async () => {
    // Slack returns a null id for the FIRST file. A compacting map would slide
    // b's id into a's slot and attach the wrong file to the draft.
    const { client } = createClient({
      "files.getUploadURLExternal": (p) => ({
        ok: true,
        upload_url: "https://upload.example/f",
        file_id: `F-${p.filename}`,
      }),
      "files.completeUploadExternal": () => ({
        ok: true,
        files: [{ id: null }, { id: "F-b.pdf" }],
      }),
    });
    const a = join(tempDir, "a.png");
    const b = join(tempDir, "b.pdf");
    await writeFile(a, "x");
    await writeFile(b, "y");
    mockFetchOk();

    const ids = await uploadFilesForDraft({ client, filePaths: [a, b] });

    expect(ids).toEqual(["F-a.png", "F-b.pdf"]);
  });

  test("falls back to staged ids when the completion response length disagrees", async () => {
    const { client } = createClient({
      "files.getUploadURLExternal": (p) => ({
        ok: true,
        upload_url: "https://upload.example/f",
        file_id: `F-${p.filename}`,
      }),
      "files.completeUploadExternal": () => ({ ok: true, files: [{ id: "F-only-one" }] }),
    });
    const a = join(tempDir, "a.png");
    const b = join(tempDir, "b.pdf");
    await writeFile(a, "x");
    await writeFile(b, "y");
    mockFetchOk();

    const ids = await uploadFilesForDraft({ client, filePaths: [a, b] });

    expect(ids).toEqual(["F-a.png", "F-b.pdf"]);
  });

  test("stages every file, then completes them in one call with no channel binding", async () => {
    const { client, calls } = createClient({
      "files.getUploadURLExternal": (p) => ({
        ok: true,
        upload_url: "https://upload.example/f",
        file_id: `F-${p.filename}`,
      }),
      "files.completeUploadExternal": (p) => ({
        ok: true,
        files: (p.files as { id?: string }[]).map((f) => ({ id: f.id, title: "t" })),
      }),
    });
    const a = join(tempDir, "a.png");
    const b = join(tempDir, "b.pdf");
    await writeFile(a, "x");
    await writeFile(b, "y");
    const fetchMock = mockFetchOk();

    const ids = await uploadFilesForDraft({ client, filePaths: [a, b] });

    expect(ids).toEqual(["F-a.png", "F-b.pdf"]);
    // Two byte POSTs, then exactly one completion carrying both files.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(completeCalls(calls)).toHaveLength(1);
    const complete = completeCalls(calls)[0]!;
    expect((complete.params.files as { id: string }[]).map((f) => f.id)).toEqual([
      "F-a.png",
      "F-b.pdf",
    ]);
    expect(complete.params).not.toHaveProperty("channel_id");
    expect(complete.params).not.toHaveProperty("thread_ts");
    expect(complete.params).not.toHaveProperty("initial_comment");
  });

  test("a later staging failure leaves nothing completed (no orphaned files)", async () => {
    let n = 0;
    const { client, calls } = createClient({
      // First file stages fine; the second getUploadURLExternal fails.
      "files.getUploadURLExternal": () => {
        n += 1;
        return n === 1
          ? { ok: true, upload_url: "https://upload.example/f", file_id: "F1" }
          : { ok: false, error: "ratelimited" };
      },
    });
    const a = join(tempDir, "a.png");
    const b = join(tempDir, "b.pdf");
    await writeFile(a, "x");
    await writeFile(b, "y");
    mockFetchOk();

    await expect(uploadFilesForDraft({ client, filePaths: [a, b] })).rejects.toThrow(
      /getUploadURLExternal failed/,
    );
    // Nothing completed => Slack discards the staged-but-uncompleted upload.
    expect(completeCalls(calls)).toHaveLength(0);
  });

  test("throws and completes nothing when a path does not exist", async () => {
    const { client, calls } = createClient({});
    mockFetchOk();

    await expect(
      uploadFilesForDraft({ client, filePaths: [join(tempDir, "missing.png")] }),
    ).rejects.toThrow();
    expect(calls.some((c) => c.method === "files.getUploadURLExternal")).toBe(false);
    expect(completeCalls(calls)).toHaveLength(0);
  });

  test("throws and completes nothing when a byte POST fails", async () => {
    const { client, calls } = createClient({
      "files.getUploadURLExternal": {
        ok: true,
        upload_url: "https://upload.example/f",
        file_id: "F1",
      },
    });
    const filePath = join(tempDir, "x.txt");
    await writeFile(filePath, "hi");
    globalThis.fetch = mock(
      async () => new Response("err", { status: 500 }),
    ) as unknown as typeof fetch;

    await expect(uploadFilesForDraft({ client, filePaths: [filePath] })).rejects.toThrow(
      /Failed to upload attachment bytes/,
    );
    expect(completeCalls(calls)).toHaveLength(0);
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

    await expect(uploadFilesForDraft({ client, filePaths: [filePath] })).rejects.toThrow(
      /completeUploadExternal failed/,
    );
  });

  test("throws when the path is a directory", async () => {
    const { client } = createClient({});
    await mkdir(join(tempDir, "adir"));
    await expect(
      uploadFilesForDraft({ client, filePaths: [join(tempDir, "adir")] }),
    ).rejects.toThrow(/not a file/);
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
