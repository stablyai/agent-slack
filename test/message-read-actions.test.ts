import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliContext } from "../src/cli/context.ts";
import type { MessageCommandOptions } from "../src/cli/message-actions.ts";
import { handleMessageList } from "../src/cli/message-read-actions.ts";

const ROOT_TS = "1700000000.000001";
const REPLY_TS = "1700000001.000002";
const originalFetch = globalThis.fetch;
const originalXdgRuntimeDir = process.env.XDG_RUNTIME_DIR;

function createContext(responses: Record<string, Record<string, unknown>>): {
  ctx: CliContext;
  calls: string[];
} {
  const calls: string[] = [];
  const client = {
    api: async (method: string): Promise<Record<string, unknown>> => {
      calls.push(method);
      const response = responses[method];
      if (!response) {
        throw new Error(`Unexpected API method: ${method}`);
      }
      return response;
    },
  };
  return {
    calls,
    ctx: {
      effectiveWorkspaceUrl: (workspace?: string) => workspace,
      assertWorkspaceSpecifiedForChannelNames: async () => {},
      withAutoRefresh: async <T>(input: { work: () => Promise<T> }) => input.work(),
      getClientForWorkspace: async () => ({
        client: client as never,
        auth: { auth_type: "standard", token: "xoxb-test" },
        workspace_url: "https://workspace.slack.com",
      }),
    } as unknown as CliContext,
  };
}

function hostedFile(id: string, metadata: { name: string; mimetype: string }) {
  return {
    id,
    ...metadata,
    mode: "hosted",
    url_private_download: `https://files.slack.com/files/${metadata.name}`,
  };
}

function snippetFile(id: string, metadata: { name: string; mimetype: string }) {
  return {
    id,
    ...metadata,
    mode: "snippet",
  };
}

function setFetchMock(fn: (...args: unknown[]) => Promise<Response>) {
  const mocked = mock(fn) as unknown as typeof globalThis.fetch;
  mocked.preconnect = () => {};
  globalThis.fetch = mocked;
  return mocked;
}

function rejectAttachmentFetch() {
  return setFetchMock(() => Promise.reject(new Error("attachment body should not be fetched")));
}

async function listMessages(
  ctx: CliContext,
  input: Omit<MessageCommandOptions, "maxBodyChars"> & { targetInput: string },
) {
  const { targetInput, ...options } = input;
  return handleMessageList({
    ctx,
    targetInput,
    options: { maxBodyChars: "8000", ...options },
  });
}

function firstFile(result: Record<string, unknown>, messageIndex = 0): Record<string, unknown> {
  return (result.messages as { files?: Record<string, unknown>[] }[])[messageIndex]!.files![0]!;
}

function expectMetadataOnly(
  file: Record<string, unknown>,
  expected: { name: string; mimetype: string; mode?: string },
) {
  expect(file).toEqual({ mode: "hosted", ...expected });
  expect(file).not.toHaveProperty("path");
  expect(file).not.toHaveProperty("error");
}

describe("message list attachment downloads", () => {
  let runtimeDir = "";

  beforeEach(async () => {
    runtimeDir = await mkdtemp(join(tmpdir(), "agent-slack-message-list-test-"));
    process.env.XDG_RUNTIME_DIR = runtimeDir;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (originalXdgRuntimeDir === undefined) {
      delete process.env.XDG_RUNTIME_DIR;
    } else {
      process.env.XDG_RUNTIME_DIR = originalXdgRuntimeDir;
    }
    await rm(runtimeDir, { recursive: true, force: true });
  });

  test("channel history keeps snippet metadata without fetching file info or bodies", async () => {
    const { ctx, calls } = createContext({
      "conversations.history": {
        messages: [
          {
            ts: ROOT_TS,
            text: "metadata only",
            user: "U11111111",
            files: [
              snippetFile("FCHANNEL", {
                name: "oversized.bin",
                mimetype: "application/octet-stream",
              }),
            ],
          },
        ],
      },
    });
    const fetchMock = rejectAttachmentFetch();

    const result = await listMessages(ctx, {
      targetInput: "C12345678",
      download: false,
    });

    expect(calls).toEqual(["conversations.history"]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      channel_id: "C12345678",
      messages: [
        {
          channel_id: "C12345678",
          ts: ROOT_TS,
          author: { user_id: "U11111111" },
          content: "metadata only",
        },
      ],
    });
    expectMetadataOnly(firstFile(result), {
      name: "oversized.bin",
      mimetype: "application/octet-stream",
      mode: "snippet",
    });
  });

  test("URL thread listing skips file info and body fetches in metadata-only mode", async () => {
    const { ctx, calls } = createContext({
      "conversations.history": {
        messages: [
          {
            ts: ROOT_TS,
            text: "thread root",
            user: "U11111111",
            files: [
              snippetFile("FROOT", {
                name: "root-snippet.txt",
                mimetype: "text/plain",
              }),
            ],
          },
        ],
      },
      "conversations.replies": {
        messages: [
          { ts: ROOT_TS, text: "thread root", user: "U11111111" },
          {
            ts: REPLY_TS,
            thread_ts: ROOT_TS,
            text: "reply with a file",
            user: "U22222222",
            files: [
              hostedFile("FTHREAD", {
                name: "thread-report.pdf",
                mimetype: "application/pdf",
              }),
            ],
          },
        ],
      },
    });
    const fetchMock = rejectAttachmentFetch();

    const result = await listMessages(ctx, {
      targetInput: "https://workspace.slack.com/archives/C12345678/p1700000000000001",
      download: false,
    });

    expect(calls).toEqual(["conversations.history", "conversations.replies"]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      messages: [
        { ts: ROOT_TS, content: "thread root", author: { user_id: "U11111111" } },
        { ts: REPLY_TS, content: "reply with a file", author: { user_id: "U22222222" } },
      ],
    });
    expectMetadataOnly(firstFile(result, 1), {
      name: "thread-report.pdf",
      mimetype: "application/pdf",
    });
  });

  test("channel thread listing keeps snippet metadata without fetching file info or bodies", async () => {
    const { ctx, calls } = createContext({
      "conversations.replies": {
        messages: [
          {
            ts: ROOT_TS,
            text: "metadata-only channel thread",
            files: [
              snippetFile("FCHANNELTHREAD", {
                name: "thread-archive.zip",
                mimetype: "application/zip",
              }),
            ],
          },
        ],
      },
    });
    const fetchMock = rejectAttachmentFetch();

    const result = await listMessages(ctx, {
      targetInput: "C12345678",
      threadTs: ROOT_TS,
      download: false,
    });

    expect(calls).toEqual(["conversations.replies"]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      messages: [{ ts: ROOT_TS, content: "metadata-only channel thread" }],
    });
    expectMetadataOnly(firstFile(result), {
      name: "thread-archive.zip",
      mimetype: "application/zip",
      mode: "snippet",
    });
  });

  test("channel --ts thread resolution does not fetch file info or bodies", async () => {
    const { ctx, calls } = createContext({
      "conversations.history": {
        messages: [
          {
            ts: REPLY_TS,
            thread_ts: ROOT_TS,
            text: "selected reply",
            files: [
              snippetFile("FSELECTED", {
                name: "selected-snippet.txt",
                mimetype: "text/plain",
              }),
            ],
          },
        ],
      },
      "conversations.replies": {
        messages: [
          {
            ts: ROOT_TS,
            text: "resolved thread root",
            files: [
              hostedFile("FRESOLVED", {
                name: "resolved.csv",
                mimetype: "text/csv",
              }),
            ],
          },
          { ts: REPLY_TS, thread_ts: ROOT_TS, text: "selected reply" },
        ],
      },
    });
    const fetchMock = rejectAttachmentFetch();

    const result = await listMessages(ctx, {
      targetInput: "C12345678",
      ts: REPLY_TS,
      download: false,
    });

    expect(calls).toEqual(["conversations.history", "conversations.replies"]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      messages: [
        { ts: ROOT_TS, content: "resolved thread root" },
        { ts: REPLY_TS, content: "selected reply" },
      ],
    });
    expectMetadataOnly(firstFile(result), {
      name: "resolved.csv",
      mimetype: "text/csv",
    });
  });

  test("channel thread listing downloads file bodies by default", async () => {
    const { ctx } = createContext({
      "conversations.replies": {
        messages: [
          {
            ts: ROOT_TS,
            text: "download this file",
            files: [
              hostedFile("FDOWNLOAD", {
                name: "report.txt",
                mimetype: "text/plain",
              }),
            ],
          },
        ],
      },
    });
    const fetchMock = setFetchMock(() =>
      Promise.resolve(
        new Response("attachment bytes", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      ),
    );

    const result = await listMessages(ctx, {
      targetInput: "C12345678",
      threadTs: ROOT_TS,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const file = firstFile(result);
    expect(file.name).toBe("report.txt");
    expect(file.error).toBeUndefined();
    expect(file.path).toBe(join(runtimeDir, "agent-slack", "tmp", "downloads", "FDOWNLOAD.txt"));
    expect(await readFile(String(file.path), "utf8")).toBe("attachment bytes");
  });
});
