import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliContext } from "../src/cli/context.ts";
import { uploadFile } from "../src/cli/file-actions.ts";

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
      workspace_url: "https://workspace.slack.com",
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

describe("uploadFile", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("uploads a single file to a channel", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-file-test-"));
    const filePath = join(dir, "report.md");
    await writeFile(filePath, "# report\n");

    const fetchMock = mock(async () => new Response("", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const result = await uploadFile({
        ctx,
        targetInput: "C12345678",
        filePaths: [filePath],
        options: { workspace: "https://workspace.slack.com" },
      });

      expect(result).toEqual({
        ok: true,
        channel_id: "C12345678",
        files_uploaded: 1,
      });
      expect(calls[0]?.method).toBe("files.getUploadURLExternal");
      expect(calls[1]?.method).toBe("files.completeUploadExternal");
      expect(calls[1]?.params.initial_comment).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("passes --comment as initial_comment on first file only", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-file-test-"));
    const first = join(dir, "report.md");
    const second = join(dir, "data.csv");
    await writeFile(first, "# report\n");
    await writeFile(second, "a,b\n1,2\n");

    const fetchMock = mock(async () => new Response("", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await uploadFile({
        ctx,
        targetInput: "C12345678",
        filePaths: [first, second],
        options: { workspace: "https://workspace.slack.com", comment: "Here are the files" },
      });

      const completes = calls.filter((c) => c.method === "files.completeUploadExternal");
      expect(completes).toHaveLength(2);
      expect(completes[0]?.params.initial_comment).toBe("Here are the files");
      expect(completes[1]?.params.initial_comment).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("uploads without comment when --comment is not provided", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-file-test-"));
    const filePath = join(dir, "data.csv");
    await writeFile(filePath, "a,b\n1,2\n");

    const fetchMock = mock(async () => new Response("", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await uploadFile({
        ctx,
        targetInput: "C12345678",
        filePaths: [filePath],
        options: { workspace: "https://workspace.slack.com" },
      });

      const complete = calls.find((c) => c.method === "files.completeUploadExternal");
      expect(complete?.params.initial_comment).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("deduplicates file paths", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-file-test-"));
    const filePath = join(dir, "report.md");
    await writeFile(filePath, "# report\n");

    const fetchMock = mock(async () => new Response("", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const result = await uploadFile({
        ctx,
        targetInput: "C12345678",
        filePaths: [filePath, filePath, `  ${filePath}  `],
        options: { workspace: "https://workspace.slack.com" },
      });

      expect(result.files_uploaded).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
