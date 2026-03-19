import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import type { CliContext } from "../src/cli/context.ts";
import { registerSearchCommand } from "../src/cli/search-command.ts";
import { searchSlack } from "../src/slack/search.ts";

type ApiCall = { method: string; params: Record<string, unknown> };

const mockUsersById: Record<
  string,
  { id: string; name: string; profile: { display_name: string } }
> = {
  U11111111: {
    id: "U11111111",
    name: "alice",
    profile: { display_name: "Alice" },
  },
  U22222222: {
    id: "U22222222",
    name: "bob",
    profile: { display_name: "Bob" },
  },
  U44444444: {
    id: "U44444444",
    name: "carol",
    profile: { display_name: "Carol" },
  },
};

function createClient(calls: ApiCall[]) {
  return {
    api: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });

      if (method === "conversations.info") {
        return { channel: { id: String(params.channel), name: "general" } };
      }

      if (method === "search.messages") {
        return {
          messages: {
            matches: [{ channel: { id: "C12345678", name: "general" } }],
          },
        };
      }

      if (method === "conversations.history") {
        return {
          messages: [
            {
              ts: "1.000001",
              text: "hello <@U22222222>",
              user: "U11111111",
              reactions: [{ name: "eyes", users: ["U11111111", "U44444444"] }],
            },
          ],
        };
      }

      if (method === "users.info") {
        const user = String(params.user);
        const resolved = mockUsersById[user];
        return {
          user: resolved ?? { id: user, name: user.toLowerCase(), profile: { display_name: user } },
        };
      }

      throw new Error(`Unexpected API method: ${method}`);
    },
  };
}

function createContext(calls: ApiCall[]): CliContext {
  const client = createClient(calls);
  return {
    effectiveWorkspaceUrl: (flag?: string) => flag,
    assertWorkspaceSpecifiedForChannelNames: async () => {},
    withAutoRefresh: async <T>(input: {
      workspaceUrl: string | undefined;
      work: () => Promise<T>;
    }) => input.work(),
    getClientForWorkspace: async () => ({
      client: client as never,
      auth: { auth_type: "standard", token: "x" },
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
  };
}

describe("search referenced users", () => {
  const originalXdg = process.env.XDG_RUNTIME_DIR;
  const originalLog = console.log;
  let runtimeDir = "";

  beforeEach(async () => {
    runtimeDir = await mkdtemp(join(tmpdir(), "agent-slack-search-test-"));
    process.env.XDG_RUNTIME_DIR = runtimeDir;
  });

  afterEach(async () => {
    process.env.XDG_RUNTIME_DIR = originalXdg;
    console.log = originalLog;
    if (runtimeDir) {
      await rm(runtimeDir, { recursive: true, force: true });
    }
  });

  test("searchSlack returns shared referenced_users while preserving canonical ids", async () => {
    const calls: ApiCall[] = [];
    const client = createClient(calls) as never;

    const result = await searchSlack({
      client,
      auth: { auth_type: "standard", token: "x" },
      options: {
        workspace_url: "https://workspace.slack.com",
        query: "hello",
        kind: "messages",
        channels: ["C12345678"],
        limit: 20,
        max_content_chars: 4000,
        content_type: "any",
        download: false,
      },
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages?.[0]?.author?.user_id).toBe("U11111111");
    expect(result.messages?.[0]?.content).toContain("@U22222222");
    expect(result.referenced_users).toEqual({
      U11111111: { id: "U11111111", name: "alice", display_name: "Alice" },
      U22222222: { id: "U22222222", name: "bob", display_name: "Bob" },
    });
    expect(result.referenced_users).not.toHaveProperty("U44444444");
  });

  test("search command forwards --refresh-users and bypasses cached user lookups", async () => {
    const calls: ApiCall[] = [];
    const ctx = createContext(calls);
    const program = new Command();
    registerSearchCommand({ program, ctx });
    console.log = mock(() => {}) as typeof console.log;

    await program.parseAsync(["search", "messages", "hello", "--channel", "general"], {
      from: "user",
    });

    const initialUsersInfoCalls = calls.filter((call) => call.method === "users.info").length;
    expect(initialUsersInfoCalls).toBe(2);

    calls.length = 0;

    await program.parseAsync(
      ["search", "messages", "hello", "--channel", "general", "--refresh-users"],
      {
        from: "user",
      },
    );

    expect(calls.filter((call) => call.method === "users.info").length).toBe(2);
  });
});
