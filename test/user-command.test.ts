import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Command } from "commander";
import type { CliContext } from "../src/cli/context.ts";
import { registerUserCommand } from "../src/cli/user-command.ts";

function createContext(input: {
  api?: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  withAutoRefresh?: CliContext["withAutoRefresh"];
  getClientForWorkspace?: CliContext["getClientForWorkspace"];
  canonicalWorkspace?: string | null;
  normalizeUrl?: CliContext["normalizeUrl"];
}) {
  const client = {
    api:
      input.api ??
      (async () => {
        throw new Error("Unexpected Slack API call");
      }),
  };
  const ctx: CliContext = {
    effectiveWorkspaceUrl: (flag?: string) => flag,
    assertWorkspaceSpecifiedForChannelNames: async () => {},
    withAutoRefresh:
      input.withAutoRefresh ??
      (async <T>(workInput: { workspaceUrl: string | undefined; work: () => Promise<T> }) =>
        workInput.work()),
    getClientForWorkspace:
      input.getClientForWorkspace ??
      (async () => ({
        client: client as never,
        auth: { auth_type: "standard", token: "x" },
        workspace_url:
          input.canonicalWorkspace === null
            ? undefined
            : (input.canonicalWorkspace ?? "https://workspace.slack.com"),
      })),
    normalizeUrl:
      input.normalizeUrl ??
      ((u: string) => {
        const url = new URL(u);
        return `${url.protocol}//${url.host}`;
      }),
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
  };
  return ctx;
}

describe("user resolve command", () => {
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

  test("prints canonical workspace and atomic mentions for a safe batch", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext({
      api: async (method, params) => {
        calls.push({ method, params });
        return {
          members: [
            {
              id: "U11111111",
              name: "alice",
              deleted: false,
              is_bot: false,
              profile: {},
            },
          ],
        };
      },
    });
    const program = new Command();
    registerUserCommand({ program, ctx });
    const log = mock((_value?: unknown) => {});
    console.log = log as typeof console.log;

    await program.parseAsync(["user", "resolve", "@alice", "--workspace", "workspace"], {
      from: "user",
    });

    expect(calls).toHaveLength(1);
    const payload = JSON.parse(String(log.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(log).toHaveBeenCalledTimes(1);
    expect(payload.workspace).toBe("https://workspace.slack.com");
    expect(payload.safe_to_mention).toBe(true);
    expect(JSON.stringify(payload)).toContain("<@U11111111>");
    expect(process.exitCode).toBe(0);
  });

  test("prints evidence, suppresses every mention, and exits nonzero for a mixed batch", async () => {
    const ctx = createContext({
      api: async () => ({
        members: [
          {
            id: "U11111111",
            name: "alice",
            deleted: false,
            is_bot: false,
            profile: {},
          },
        ],
      }),
    });
    const program = new Command();
    registerUserCommand({ program, ctx });
    const log = mock((_value?: unknown) => {});
    console.log = log as typeof console.log;

    await program.parseAsync(["user", "resolve", "@alice", "@missing"], {
      from: "user",
    });

    const output = String(log.mock.calls[0]?.[0]);
    expect(log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(output) as { safe_to_mention: boolean };
    expect(payload.safe_to_mention).toBe(false);
    expect(output).not.toContain("<@");
    expect(process.exitCode).toBe(1);
  });

  test("turns a terminal directory request failure into structured incomplete JSON", async () => {
    const ctx = createContext({
      api: async () => {
        throw new Error("Slack API call users.list was rate limited");
      },
    });
    const program = new Command();
    registerUserCommand({ program, ctx });
    const log = mock((_value?: unknown) => {});
    const error = mock((_value?: unknown) => {});
    console.log = log as typeof console.log;
    console.error = error as typeof console.error;

    await program.parseAsync(["user", "resolve", "@alice"], { from: "user" });

    const output = String(log.mock.calls[0]?.[0]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(output)).toMatchObject({
      directory: {
        status: "incomplete",
        pages: 0,
        reason: "rate_limited",
      },
      safe_to_mention: false,
    });
    expect(JSON.parse(output)).not.toHaveProperty("results");
    expect(output).not.toContain("<@");
    expect(error).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test("restarts from page one with a fresh client after page-two invalid_auth", async () => {
    const cursors: (string | undefined)[] = [];
    let clientAttempts = 0;
    let workAttempts = 0;
    const firstClient = {
      api: async (_method: string, params: Record<string, unknown>) => {
        cursors.push(params.cursor as string | undefined);
        if (params.cursor === undefined) {
          return {
            members: [
              {
                id: "U11111111",
                name: "alice",
                deleted: false,
                is_bot: false,
                profile: {},
              },
            ],
            response_metadata: { next_cursor: "cursor-1" },
          };
        }
        throw new Error("invalid_auth");
      },
    };
    const secondClient = {
      api: async (_method: string, params: Record<string, unknown>) => {
        cursors.push(params.cursor as string | undefined);
        return {
          members: [
            {
              id: "U22222222",
              name: "alice",
              deleted: false,
              is_bot: false,
              profile: {},
            },
          ],
          response_metadata: { next_cursor: "" },
        };
      },
    };
    const ctx = createContext({
      withAutoRefresh: async <T>(input: {
        workspaceUrl: string | undefined;
        work: () => Promise<T>;
      }) => {
        workAttempts += 1;
        try {
          return await input.work();
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes("invalid_auth")) {
            throw error;
          }
          workAttempts += 1;
          return input.work();
        }
      },
      getClientForWorkspace: async () => {
        const client = clientAttempts++ === 0 ? firstClient : secondClient;
        return {
          client: client as never,
          auth: { auth_type: "standard", token: "x" },
          workspace_url: "https://workspace.slack.com",
        };
      },
    });
    const program = new Command();
    registerUserCommand({ program, ctx });
    const log = mock((_value?: unknown) => {});
    console.log = log as typeof console.log;

    await program.parseAsync(["user", "resolve", "@alice"], { from: "user" });

    expect(clientAttempts).toBe(2);
    expect(workAttempts).toBe(2);
    expect(cursors).toEqual([undefined, "cursor-1", undefined]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain("<@U22222222>");
    expect(String(log.mock.calls[0]?.[0])).not.toContain("U11111111");
    expect(process.exitCode).toBe(0);
  });

  test("never serializes an unvalidated returned workspace", async () => {
    const ctx = createContext({
      canonicalWorkspace: "<@U99999999>",
      api: async () => ({
        members: [
          {
            id: "U11111111",
            name: "alice",
            deleted: false,
            is_bot: false,
            profile: {},
          },
        ],
      }),
    });
    const program = new Command();
    registerUserCommand({ program, ctx });
    const log = mock((_value?: unknown) => {});
    console.log = log as typeof console.log;

    await program.parseAsync(
      ["user", "resolve", "@alice", "@missing", "--workspace", "<@U88888888>"],
      { from: "user" },
    );

    expect(log).toHaveBeenCalledTimes(1);
    const output = String(log.mock.calls[0]?.[0]);
    expect(JSON.parse(output)).not.toHaveProperty("workspace");
    expect(output).not.toContain("<@");
    expect(process.exitCode).toBe(1);
  });

  test("makes workspace-resolution errors inert", async () => {
    const ctx = createContext({
      getClientForWorkspace: async () => {
        throw new Error(
          'No configured workspace matches selector "<@U99999999> <!here> @channel".',
        );
      },
    });
    const program = new Command();
    registerUserCommand({ program, ctx });
    const log = mock((_value?: unknown) => {});
    const error = mock((_value?: unknown) => {});
    console.log = log as typeof console.log;
    console.error = error as typeof console.error;

    await program.parseAsync(["user", "resolve", "@alice", "--workspace", "<@U99999999>"], {
      from: "user",
    });

    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    const output = String(error.mock.calls[0]?.[0]);
    expect(output).not.toContain("<@");
    expect(output).not.toContain("<!");
    expect(process.exitCode).toBe(1);
  });

  test("rejects malformed handles without echoing them", async () => {
    const ctx = createContext({
      api: async () => {
        throw new Error("should not call Slack");
      },
    });
    const program = new Command();
    registerUserCommand({ program, ctx });
    const log = mock((_value?: unknown) => {});
    const error = mock((_value?: unknown) => {});
    console.log = log as typeof console.log;
    console.error = error as typeof console.error;

    await program.parseAsync(["user", "resolve", "@"], { from: "user" });

    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("Slack handles must be non-empty and contain no whitespace");
    expect(process.exitCode).toBe(1);
  });
});
