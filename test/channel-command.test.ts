import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Command } from "commander";
import type { CliContext } from "../src/cli/context.ts";
import { registerChannelCommand } from "../src/cli/channel-command.ts";

function createContext() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const client = {
    api: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "users.list") {
        return {
          members: [{ id: "U123", name: "alice" }],
          response_metadata: { next_cursor: "" },
        };
      }
      return {
        channels: [{ id: "C1", name: "general" }],
        response_metadata: { next_cursor: "n1" },
      };
    },
  };

  const ctx: CliContext = {
    effectiveWorkspaceUrl: (flag?: string) => flag,
    assertWorkspaceSpecifiedForChannelNames: async () => {},
    withAutoRefresh: async <T>(input: {
      workspaceUrl: string | undefined;
      work: () => Promise<T>;
    }) => input.work(),
    getClientForWorkspace: async () => ({
      client: client as never,
      auth: { auth_type: "standard", token: "x" },
    }),
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
    importChrome: () => ({ cookie_d: "", teams: [] }),
    importBrave: async () => null,
  };

  return { ctx, calls };
}

describe("channel list command", () => {
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

  test("defaults to users.conversations for current user", async () => {
    const { ctx, calls } = createContext();
    const program = new Command();
    registerChannelCommand({ program, ctx });
    const log = mock(() => {});
    console.log = log as typeof console.log;

    await program.parseAsync(["channel", "list"], { from: "user" });

    expect(calls[0]?.method).toBe("users.conversations");
    expect(calls[0]?.params.limit).toBe(100);
    expect(calls[0]?.params.exclude_archived).toBe(true);
    expect(log).toHaveBeenCalled();
  });

  test("with --user id uses users.conversations and sets user directly", async () => {
    const { ctx, calls } = createContext();
    const program = new Command();
    registerChannelCommand({ program, ctx });
    const log = mock(() => {});
    console.log = log as typeof console.log;

    await program.parseAsync(["channel", "list", "--user", "U12345678"], { from: "user" });

    const convoCall = calls.find((c) => c.method === "users.conversations");
    expect(convoCall?.params.user).toBe("U12345678");
  });

  test("with --user handle resolves via users.list before users.conversations", async () => {
    const { ctx, calls } = createContext();
    const program = new Command();
    registerChannelCommand({ program, ctx });
    const log = mock(() => {});
    console.log = log as typeof console.log;

    await program.parseAsync(["channel", "list", "--user", "@alice"], { from: "user" });

    expect(calls.some((c) => c.method === "users.list")).toBe(true);
    const convoCall = calls.find((c) => c.method === "users.conversations");
    expect(convoCall?.params.user).toBe("U123");
  });

  test("with --all uses conversations.list", async () => {
    const { ctx, calls } = createContext();
    const program = new Command();
    registerChannelCommand({ program, ctx });
    const log = mock(() => {});
    console.log = log as typeof console.log;

    await program.parseAsync(["channel", "list", "--all"], { from: "user" });

    expect(calls[0]?.method).toBe("conversations.list");
    expect(calls[0]?.params.exclude_archived).toBe(true);
  });

  test("forwards --limit and --cursor", async () => {
    const { ctx, calls } = createContext();
    const program = new Command();
    registerChannelCommand({ program, ctx });
    const log = mock(() => {});
    console.log = log as typeof console.log;

    await program.parseAsync(["channel", "list", "--limit", "50", "--cursor", "cursor-1"], {
      from: "user",
    });

    expect(calls[0]?.params.limit).toBe(50);
    expect(calls[0]?.params.cursor).toBe("cursor-1");
  });

  test("--all and --user is a hard error", async () => {
    const { ctx, calls } = createContext();
    const program = new Command();
    registerChannelCommand({ program, ctx });
    const err = mock(() => {});
    console.error = err as typeof console.error;

    await program.parseAsync(["channel", "list", "--all", "--user", "U123"], { from: "user" });

    expect(calls).toHaveLength(0);
    expect(err).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test("invalid --limit is a hard error", async () => {
    const { ctx, calls } = createContext();
    const program = new Command();
    registerChannelCommand({ program, ctx });
    const err = mock(() => {});
    console.error = err as typeof console.error;

    await program.parseAsync(["channel", "list", "--limit", "abc"], { from: "user" });

    expect(calls).toHaveLength(0);
    expect(err).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test("help text documents single-page pagination model", () => {
    const { ctx } = createContext();
    const program = new Command();
    registerChannelCommand({ program, ctx });
    const channelCmd = program.commands.find((cmd) => cmd.name() === "channel");
    const listCmd = channelCmd?.commands.find((cmd) => cmd.name() === "list");

    const limitOpt = listCmd?.options.find((opt) => opt.long === "--limit");
    const cursorOpt = listCmd?.options.find((opt) => opt.long === "--cursor");

    expect(limitOpt?.description).toContain("one page");
    expect(cursorOpt?.description).toContain("next page");
  });
});
