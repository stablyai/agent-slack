import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import type { CliContext } from "../src/cli/context.ts";
import { readCanvasMarkdownInput, registerCanvasCommand } from "../src/cli/canvas-command.ts";
import { createCanvasFromMarkdown, editCanvas } from "../src/slack/canvas.ts";
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

describe("editCanvas", () => {
  test.each([
    [
      "replace",
      undefined,
      { operation: "replace", document_content: { type: "markdown", markdown: "# Revised\n" } },
    ],
    [
      "replace section",
      "temp:C:SECTION",
      {
        operation: "replace",
        section_id: "temp:C:SECTION",
        document_content: { type: "markdown", markdown: "Updated section" },
      },
    ],
    [
      "insert before",
      "temp:C:SECTION",
      {
        operation: "insert_before",
        section_id: "temp:C:SECTION",
        document_content: { type: "markdown", markdown: "Before" },
      },
    ],
    [
      "insert after",
      "temp:C:SECTION",
      {
        operation: "insert_after",
        section_id: "temp:C:SECTION",
        document_content: { type: "markdown", markdown: "After" },
      },
    ],
    [
      "insert at start",
      undefined,
      {
        operation: "insert_at_start",
        document_content: { type: "markdown", markdown: "Start" },
      },
    ],
    [
      "insert at end",
      undefined,
      {
        operation: "insert_at_end",
        document_content: { type: "markdown", markdown: "End" },
      },
    ],
    ["delete section", "temp:C:SECTION", { operation: "delete", section_id: "temp:C:SECTION" }],
    [
      "rename",
      undefined,
      {
        operation: "rename",
        title_content: { type: "markdown", markdown: "Project status" },
      },
    ],
  ] as const)("sends the documented %s change", async (_name, sectionId, expectedChange) => {
    const { client, calls } = createClient({ ok: true });
    const { operation } = expectedChange;
    const markdown =
      "document_content" in expectedChange ? expectedChange.document_content.markdown : undefined;
    const title =
      "title_content" in expectedChange ? expectedChange.title_content.markdown : undefined;
    const result = await editCanvas(client, {
      canvasId: " F12345678 ",
      operation,
      markdown,
      title,
      sectionId,
    });

    expect(calls).toEqual([
      {
        transport: "json",
        method: "canvases.edit",
        params: { canvas_id: "F12345678", changes: [expectedChange] },
      },
    ]);
    expect(result).toEqual({ ok: true, canvas: { id: "F12345678", operation } });
  });

  test("rejects invalid combinations before calling Slack", async () => {
    const cases = [
      {
        input: { operation: "insert_after", markdown: "Body" },
        message: 'operation "insert_after" requires --section-id',
      },
      {
        input: { operation: "insert_at_end", markdown: "Body", sectionId: "temp:C:SECTION" },
        message: 'operation "insert_at_end" cannot use --section-id',
      },
      {
        input: { operation: "delete" },
        message: 'operation "delete" requires --section-id',
      },
      {
        input: { operation: "rename" },
        message: 'operation "rename" requires a non-empty --title',
      },
      {
        input: { operation: "replace", markdown: "Body", title: "Wrong" },
        message: "--title is only valid with the rename operation",
      },
      {
        input: { operation: "nope", markdown: "Body" },
        message: 'Unsupported canvas edit operation "nope"',
      },
    ] as const;

    for (const testCase of cases) {
      const { client, calls } = createClient({ ok: true });
      await expect(
        editCanvas(client, { canvasId: "F12345678", ...testCase.input }),
      ).rejects.toThrow(testCase.message);
      expect(calls).toHaveLength(0);
    }
  });

  test("rejects empty Markdown and canvas ids before calling Slack", async () => {
    const { client, calls } = createClient({ ok: true });
    await expect(
      editCanvas(client, { canvasId: "F12345678", operation: "replace", markdown: " \n" }),
    ).rejects.toThrow("requires non-empty Markdown");
    await expect(
      editCanvas(client, { canvasId: " ", operation: "delete", sectionId: "temp:C:SECTION" }),
    ).rejects.toThrow("Canvas id is required");
    expect(calls).toHaveLength(0);
  });

  test("rejects Markdown over Slack's per-change limit before calling Slack", async () => {
    const { client, calls } = createClient({ ok: true });
    await expect(
      editCanvas(client, {
        canvasId: "F12345678",
        operation: "replace",
        markdown: "x".repeat(1_048_577),
      }),
    ).rejects.toThrow("character limit");
    await expect(
      editCanvas(client, {
        canvasId: "F12345678",
        operation: "rename",
        title: "x".repeat(1_048_577),
      }),
    ).rejects.toThrow("character limit");
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

describe("canvas edit command", () => {
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

  test("replaces a canvas from a Markdown URL target", async () => {
    const { client, calls } = createClient({ ok: true });
    const { ctx, workspaceSelections } = createContext(client);
    const program = new Command();
    registerCanvasCommand({ program, ctx });
    const log = mock((_value?: unknown) => {});
    console.log = log as typeof console.log;

    await program.parseAsync(
      ["canvas", "edit", "https://acme.slack.com/docs/T123/F12345678", "--markdown", "# Revised\n"],
      { from: "user" },
    );

    expect(workspaceSelections).toEqual(["https://acme.slack.com"]);
    expect(calls[0]).toEqual({
      transport: "json",
      method: "canvases.edit",
      params: {
        canvas_id: "F12345678",
        changes: [
          { operation: "replace", document_content: { type: "markdown", markdown: "# Revised\n" } },
        ],
      },
    });
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      ok: true,
      canvas: { id: "F12345678", operation: "replace" },
    });
  });

  test("inserts content from a file and passes a section id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-canvas-edit-command-"));
    const path = join(dir, "addition.md");
    try {
      await writeFile(path, "Added\n", "utf8");
      const { client, calls } = createClient({ ok: true });
      const { ctx } = createContext(client);
      const program = new Command();
      registerCanvasCommand({ program, ctx });
      console.log = mock(() => {}) as typeof console.log;

      await program.parseAsync(
        [
          "canvas",
          "edit",
          "F12345678",
          "--operation",
          "insert_after",
          "--section-id",
          "temp:C:SECTION",
          "--file",
          path,
        ],
        { from: "user" },
      );

      expect(calls[0]?.params).toEqual({
        canvas_id: "F12345678",
        changes: [
          {
            operation: "insert_after",
            section_id: "temp:C:SECTION",
            document_content: { type: "markdown", markdown: "Added\n" },
          },
        ],
      });
      expect(process.exitCode).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("renames without a Markdown source", async () => {
    const { client, calls } = createClient({ ok: true });
    const { ctx } = createContext(client);
    const program = new Command();
    registerCanvasCommand({ program, ctx });
    console.log = mock(() => {}) as typeof console.log;

    await program.parseAsync(
      ["canvas", "edit", "F12345678", "--operation", "rename", "--title", "Renamed"],
      { from: "user" },
    );

    expect(calls[0]?.params).toEqual({
      canvas_id: "F12345678",
      changes: [{ operation: "rename", title_content: { type: "markdown", markdown: "Renamed" } }],
    });
  });

  test("rejects delete content and malformed inputs before authenticating", async () => {
    const { client, calls } = createClient({ ok: true });
    const { ctx, workspaceSelections } = createContext(client);
    const program = new Command();
    registerCanvasCommand({ program, ctx });
    const error = mock((_value?: unknown) => {});
    console.error = error as typeof console.error;

    await program.parseAsync(
      [
        "canvas",
        "edit",
        "F12345678",
        "--operation",
        "delete",
        "--section-id",
        "x",
        "--markdown",
        "nope",
      ],
      { from: "user" },
    );
    await program.parseAsync(
      ["canvas", "edit", "F12345678", "--operation", "not-real", "--markdown", "nope"],
      { from: "user" },
    );

    expect(calls).toHaveLength(0);
    expect(workspaceSelections).toHaveLength(0);
    expect(error).toHaveBeenCalledTimes(2);
    expect(String(error.mock.calls[0]?.[0])).toContain("does not accept Markdown content");
    expect(String(error.mock.calls[1]?.[0])).toContain("Unsupported canvas edit operation");
    expect(process.exitCode).toBe(1);
  });

  test("rejects browser credentials before calling canvases.edit", async () => {
    const { client, calls } = createClient({ ok: true });
    const { ctx } = createContext(client, {
      auth_type: "browser",
      xoxc_token: "xoxc-test",
      xoxd_cookie: "xoxd-test",
    });
    const program = new Command();
    registerCanvasCommand({ program, ctx });
    const error = mock((_value?: unknown) => {});
    console.error = error as typeof console.error;

    await program.parseAsync(["canvas", "edit", "F12345678", "--markdown", "# Revised"], {
      from: "user",
    });

    expect(calls).toHaveLength(0);
    expect(String(error.mock.calls[0]?.[0])).toContain("standard Slack token");
    expect(process.exitCode).toBe(1);
  });
});
