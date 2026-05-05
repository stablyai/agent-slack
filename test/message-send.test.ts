import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliContext } from "../src/cli/context.ts";
import { sendMessage } from "../src/cli/message-actions.ts";

function createContext(calls: { method: string; params: Record<string, unknown> }[]) {
  const client = {
    api: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "files.getUploadURLExternal") {
        return { ok: true, upload_url: "https://upload.example/file", file_id: "F123" };
      }
      return { ok: true };
    },
  };

  return {
    effectiveWorkspaceUrl: (flag?: string) => flag,
    assertWorkspaceSpecifiedForChannelNames: async () => {},
    withAutoRefresh: async <T>(input: {
      workspaceUrl: string | undefined;
      work: () => Promise<T>;
    }) => input.work(),
    getClientForWorkspace: async () => ({
      client: client as never,
      auth: { auth_type: "standard", token: "x" as const },
    }),
    normalizeUrl: (u: string) => u,
    errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
    parseContentType: () => "any",
    parseCurl: () => ({
      workspace_url: "https://workspace.slack.com",
      xoxc_token: "xoxc-1",
      xoxd_cookie: "xoxd-1",
    }),
    importDesktop: async () => ({
      cookie_d: "",
      teams: [],
      source: { leveldb_path: "", cookies_path: "" },
    }),
    importChrome: () => ({ cookie_d: "", teams: [] }),
    importBrave: async () => null,
    importFirefox: async () => null,
  } satisfies CliContext;
}

describe("sendMessage", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("posts a normal message when no attachments are passed", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);

    await sendMessage({
      ctx,
      targetInput: "C12345678",
      text: "hello",
      options: {},
    });

    expect(calls).toEqual([
      {
        method: "chat.postMessage",
        params: {
          channel: "C12345678",
          text: "hello",
          thread_ts: undefined,
        },
      },
    ]);
  });

  test("uploads attachment and uses message text as initial comment", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-send-test-"));
    const filePath = join(dir, "report.md");
    await writeFile(filePath, "# report\n");

    const fetchMock = mock(async () => new Response("", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await sendMessage({
        ctx,
        targetInput: "C12345678",
        text: "here's the report",
        options: { attach: [filePath] },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    expect(calls[0]?.method).toBe("files.getUploadURLExternal");
    expect(calls[1]?.method).toBe("files.completeUploadExternal");
    expect(calls[1]?.params.initial_comment).toBe("here's the report");
    expect(calls.some((c) => c.method === "chat.postMessage")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("sends initial comment only for the first attachment", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-send-test-"));
    const first = join(dir, "report.md");
    const second = join(dir, "log.txt");
    await writeFile(first, "# report\n");
    await writeFile(second, "ok\n");

    const fetchMock = mock(async () => new Response("", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await sendMessage({
        ctx,
        targetInput: "C12345678",
        text: "see files",
        options: { attach: [first, second] },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    const completes = calls.filter((c) => c.method === "files.completeUploadExternal");
    expect(completes).toHaveLength(2);
    expect(completes[0]?.params.initial_comment).toBe("see files");
    expect(completes[1]?.params.initial_comment).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("uploads attachment without text when text is empty", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-send-test-"));
    const filePath = join(dir, "data.csv");
    await writeFile(filePath, "a,b\n1,2\n");

    const fetchMock = mock(async () => new Response("", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await sendMessage({
        ctx,
        targetInput: "C12345678",
        text: "",
        options: { attach: [filePath] },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    expect(calls[0]?.method).toBe("files.getUploadURLExternal");
    expect(calls[1]?.method).toBe("files.completeUploadExternal");
    expect(calls[1]?.params.initial_comment).toBeUndefined();
    expect(calls.some((c) => c.method === "chat.postMessage")).toBe(false);
  });

  test("--blocks: reads Block Kit JSON from file and passes through unchanged", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-send-test-"));
    const blocksPath = join(dir, "blocks.json");
    const blocks = [
      { type: "header", text: { type: "plain_text", text: "Digest" } },
      {
        type: "table",
        rows: [
          [
            { type: "raw_text", text: "Name" },
            { type: "raw_text", text: "Why" },
          ],
          [
            { type: "raw_text", text: "Caveman" },
            { type: "raw_text", text: "token cut" },
          ],
        ],
      },
    ];
    await writeFile(blocksPath, JSON.stringify(blocks));

    try {
      await sendMessage({
        ctx,
        targetInput: "C12345678",
        text: "fallback text",
        options: { blocks: blocksPath },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("chat.postMessage");
    expect(calls[0]?.params).toEqual({
      channel: "C12345678",
      text: "fallback text",
      thread_ts: undefined,
      blocks,
    });
  });

  test("--blocks: errors when JSON is not an array", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-send-test-"));
    const blocksPath = join(dir, "blocks.json");
    await writeFile(blocksPath, JSON.stringify({ type: "header" }));

    try {
      expect(
        sendMessage({
          ctx,
          targetInput: "C12345678",
          text: "",
          options: { blocks: blocksPath },
        }),
      ).rejects.toThrow(/expected a JSON array/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("--blocks: errors on malformed JSON", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-send-test-"));
    const blocksPath = join(dir, "blocks.json");
    await writeFile(blocksPath, "{not valid json");

    try {
      expect(
        sendMessage({
          ctx,
          targetInput: "C12345678",
          text: "",
          options: { blocks: blocksPath },
        }),
      ).rejects.toThrow(/failed to parse JSON/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("--blocks: overrides markdown-to-rich-text conversion when text is also provided", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-send-test-"));
    const blocksPath = join(dir, "blocks.json");
    const blocks = [{ type: "divider" }];
    await writeFile(blocksPath, JSON.stringify(blocks));

    try {
      await sendMessage({
        ctx,
        targetInput: "C12345678",
        text: "- bullet one\n- bullet two",
        options: { blocks: blocksPath },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    expect(calls[0]?.params.blocks).toEqual(blocks);
  });

  test("--blocks: errors when an array element is not an object", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-send-test-"));
    const blocksPath = join(dir, "blocks.json");
    await writeFile(blocksPath, JSON.stringify([{ type: "divider" }, "oops"]));

    try {
      await expect(
        sendMessage({
          ctx,
          targetInput: "C12345678",
          text: "",
          options: { blocks: blocksPath },
        }),
      ).rejects.toThrow(/element at index 1 is not a Block Kit block object/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
