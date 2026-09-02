import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import type { CliContext } from "../src/cli/context.ts";
import { readCanvasMarkdownInput, registerCanvasCommand } from "../src/cli/canvas-command.ts";
import { createCanvasFromMarkdown } from "../src/slack/canvas.ts";
import type { SlackApiClient, SlackAuth } from "../src/slack/client.ts";

function createClient(response: Record<string, unknown> = { ok: true, canvas_id: "F12345678" }) {
  const calls: {
    transport: "json" | "multipart";
    method: string;
    params: Record<string, unknown>;
  }[] = [];
  const api = (transport: "json" | "multipart") => {
    return async (method: string, params: Record<string, unknown>) => {
      calls.push({ transport, method, params });
      return response;
    };
  };
  const client = {
    api: api("json"),
    apiMultipart: api("multipart"),
  } as unknown as SlackApiClient;
  return { client, calls };
}

function createContext(
  client: SlackApiClient,
  auth: SlackAuth = { auth_type: "standard", token: "x" },
) {
  const workspaceSelections: (string | undefined)[] = [];
  const assertedChannels: string[][] = [];
  const ctx: CliContext = {
    effectiveWorkspaceUrl: (flag?: string) => flag,
    assertWorkspaceSpecifiedForChannelNames: async ({ channels }) => {
      assertedChannels.push(channels);
    },
    withAutoRefresh: async <T>(input: {
      workspaceUrl: string | undefined;
      work: () => Promise<T>;
    }) => input.work(),
    getClientForWorkspace: async (workspaceUrl?: string) => {
      workspaceSelections.push(workspaceUrl);
      return {
        client,
        auth,
        workspace_url: workspaceUrl,
      };
    },
    normalizeUrl: (u: string) => u,
    errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
    parseContentType: () => "any",
    parseCurl: (_curl: string) => ({
      workspace_url: "https://workspace.slack.com",
      xoxc_token: "xoxc-1",
      xoxd_cookie: "xoxd-1",
    }),
    importDesktop: async () => ({
      cookie_d: "",
      teams: [],
      source: { leveldb_path: "", cookies_path: "" },
    }),
    importChrome: async () => ({ cookie_d: "", teams: [] }),
    importBrave: async () => null,
    importFirefox: async () => null,
  };
  return { ctx, workspaceSelections, assertedChannels };
}

describe("createCanvasFromMarkdown", () => {
  test("sends Markdown content, title, and channel to canvases.create", async () => {
    const { client, calls } = createClient();

    const result = await createCanvasFromMarkdown(client, {
      auth: { auth_type: "standard", token: "x" },
      markdown: "# Launch plan\n\n- Ship it\n",
      title: "  Launch plan  ",
      channelId: "C12345678",
    });

    expect(calls).toEqual([
      {
        transport: "json",
        method: "canvases.create",
        params: {
          title: "Launch plan",
          document_content: {
            type: "markdown",
            markdown: "# Launch plan\n\n- Ship it\n",
          },
          channel_id: "C12345678",
        },
      },
    ]);
    expect(result).toEqual({
      canvas: { id: "F12345678", title: "Launch plan", channel_id: "C12345678" },
    });
  });

  test("rejects empty Markdown before calling Slack", async () => {
    const { client, calls } = createClient();

    await expect(
      createCanvasFromMarkdown(client, {
        auth: { auth_type: "standard", token: "x" },
        markdown: "  \n",
      }),
    ).rejects.toThrow("Canvas Markdown is empty");
    expect(calls).toHaveLength(0);
  });

  test("rejects a success response without a canvas id", async () => {
    const { client } = createClient({ ok: true });

    await expect(
      createCanvasFromMarkdown(client, {
        auth: { auth_type: "standard", token: "x" },
        markdown: "Hello",
      }),
    ).rejects.toThrow("Slack returned no canvas id");
  });

  test("uses Slack's Markdown canvas method with imported browser credentials", async () => {
    const { client, calls } = createClient({ ok: true, file_id: "F87654321" });

    const result = await createCanvasFromMarkdown(client, {
      auth: {
        auth_type: "browser",
        xoxc_token: "xoxc-test",
        xoxd_cookie: "xoxd-test",
      },
      markdown: "# Browser auth\n",
    });

    expect(calls).toEqual([
      {
        transport: "multipart",
        method: "files.createCanvas",
        params: {
          title: "Untitled",
          markdown: "# Browser auth\n",
          loosenValidation: true,
        },
      },
    ]);
    expect(result).toEqual({ canvas: { id: "F87654321", title: "Untitled" } });
  });

  test("rejects channel tabs with browser credentials before calling Slack", async () => {
    const { client, calls } = createClient({ ok: true, file_id: "F87654321" });

    await expect(
      createCanvasFromMarkdown(client, {
        auth: {
          auth_type: "browser",
          xoxc_token: "xoxc-test",
          xoxd_cookie: "xoxd-test",
        },
        markdown: "# Browser auth\n",
        channelId: "C12345678",
      }),
    ).rejects.toThrow("requires a standard Slack token");
    expect(calls).toHaveLength(0);
  });
});

describe("readCanvasMarkdownInput", () => {
  test("reads a Markdown file without changing its contents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-canvas-"));
    const path = join(dir, "plan.md");
    try {
      await writeFile(path, "# Plan\n\nBody\n", "utf8");
      await expect(readCanvasMarkdownInput({ file: path })).resolves.toBe("# Plan\n\nBody\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("accepts a Markdown blob", async () => {
    await expect(readCanvasMarkdownInput({ markdown: "# Inline\n" })).resolves.toBe("# Inline\n");
  });

  test("requires exactly one source", async () => {
    await expect(readCanvasMarkdownInput({})).rejects.toThrow("Pass exactly one");
    await expect(
      readCanvasMarkdownInput({ file: "plan.md", markdown: "# Inline" }),
    ).rejects.toThrow("Pass exactly one");
  });

  test("rejects an empty source", async () => {
    await expect(readCanvasMarkdownInput({ markdown: "\n \t" })).rejects.toThrow(
      "Canvas Markdown is empty",
    );
  });
});

describe("canvas create command", () => {
  const originalLog = console.log;
  const originalError = console.error;

  beforeEach(() => {
    process.exitCode = 0;
  });

  afterEach(() => {
    process.exitCode = 0;
    console.log = originalLog;
    console.error = originalError;
  });

  test("creates from an inline blob in the selected workspace", async () => {
    const { client, calls } = createClient();
    const { ctx, workspaceSelections } = createContext(client);
    const program = new Command();
    registerCanvasCommand({ program, ctx });
    const log = mock((_value?: unknown) => {});
    console.log = log as typeof console.log;

    await program.parseAsync(
      ["canvas", "create", "--markdown", "# Inline\n", "--title", "Inline", "--workspace", "acme"],
      { from: "user" },
    );

    expect(workspaceSelections).toEqual(["acme"]);
    expect(calls[0]?.method).toBe("canvases.create");
    expect(calls[0]?.params.document_content).toEqual({
      type: "markdown",
      markdown: "# Inline\n",
    });
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      canvas: { id: "F12345678", title: "Inline" },
    });
    expect(process.exitCode).toBe(0);
  });

  test("creates from a file and resolves a channel tab", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-canvas-command-"));
    const path = join(dir, "plan.md");
    try {
      await writeFile(path, "# Plan\n", "utf8");
      const { client, calls } = createClient();
      const { ctx, assertedChannels } = createContext(client);
      const program = new Command();
      registerCanvasCommand({ program, ctx });
      console.log = mock(() => {}) as typeof console.log;

      await program.parseAsync(["canvas", "create", "--file", path, "--channel", "C12345678"], {
        from: "user",
      });

      expect(assertedChannels).toEqual([["C12345678"]]);
      expect(calls[0]?.params.channel_id).toBe("C12345678");
      expect(calls[0]?.params.document_content).toEqual({
        type: "markdown",
        markdown: "# Plan\n",
      });
      expect(process.exitCode).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects browser-auth channel tabs before resolving the channel", async () => {
    const { client, calls } = createClient({ ok: true, file_id: "F87654321" });
    const { ctx } = createContext(client, {
      auth_type: "browser",
      xoxc_token: "xoxc-test",
      xoxd_cookie: "xoxd-test",
    });
    const program = new Command();
    registerCanvasCommand({ program, ctx });
    const error = mock((_value?: unknown) => {});
    console.error = error as typeof console.error;

    await program.parseAsync(
      ["canvas", "create", "--markdown", "# Browser auth\n", "--channel", "project-launch"],
      { from: "user" },
    );

    expect(calls).toHaveLength(0);
    expect(String(error.mock.calls[0]?.[0])).toContain("requires a standard Slack token");
    expect(process.exitCode).toBe(1);
  });

  test("rejects missing or conflicting sources before authenticating", async () => {
    const { client, calls } = createClient();
    const { ctx, workspaceSelections } = createContext(client);
    const program = new Command();
    registerCanvasCommand({ program, ctx });
    const error = mock(() => {});
    console.error = error as typeof console.error;

    await program.parseAsync(["canvas", "create"], { from: "user" });
    await program.parseAsync(["canvas", "create", "--file", "plan.md", "--markdown", "# Inline"], {
      from: "user",
    });

    expect(error).toHaveBeenCalledTimes(2);
    expect(workspaceSelections).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(process.exitCode).toBe(1);
  });
});
