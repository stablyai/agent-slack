import { describe, expect, spyOn, test } from "bun:test";
import { Command } from "commander";
import type { CliContext } from "../src/cli/context.ts";
import {
  createDraftAction,
  deleteDraftAction,
  listDraftsAction,
  updateDraftAction,
} from "../src/cli/message-draft-actions.ts";
import { registerMessageDraftCommand } from "../src/cli/message-draft-command.ts";

type Call = { method: string; params: Record<string, unknown> };

/**
 * Build a mock CliContext whose client records every api() call and answers
 * drafts.* / conversations.info from the supplied fixtures. Mirrors the
 * createContext helper in message-send.test.ts.
 */
function createContext(
  calls: Call[],
  fixtures: {
    draftsList?: Record<string, unknown>[];
    channelInfo?: Record<string, Record<string, unknown>>;
  } = {},
) {
  const client = {
    api: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      switch (method) {
        case "drafts.list":
          return { ok: true, drafts: fixtures.draftsList ?? [] };
        case "drafts.create":
          return { ok: true, draft: { id: "DrNew", destinations: params.destinations } };
        case "drafts.update":
          return {
            ok: true,
            draft: { id: String(params.draft_id), destinations: params.destinations },
          };
        case "drafts.delete":
          return { ok: true };
        case "conversations.open":
          return { ok: true, channel: { id: "D99999999" } };
        case "conversations.info": {
          const info = fixtures.channelInfo?.[String(params.channel)];
          return info ? { ok: true, channel: info } : { ok: true };
        }
        default:
          return { ok: true };
      }
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

function draftsUpdateCall(calls: Call[]): Call {
  const call = calls.find((c) => c.method === "drafts.update");
  if (!call) {
    throw new Error("expected a drafts.update call");
  }
  return call;
}

describe("createDraftAction", () => {
  test("creates a draft addressed to a channel id", async () => {
    const calls: Call[] = [];
    const ctx = createContext(calls);

    const result = await createDraftAction({
      ctx,
      targetInput: "C11111111",
      text: "hello",
      options: { workspace: "https://workspace.slack.com" },
    });

    const create = calls.find((c) => c.method === "drafts.create");
    expect(create).toBeDefined();
    expect(create?.params.destinations).toEqual([{ channel_id: "C11111111" }]);
    expect(Array.isArray(create?.params.blocks)).toBe(true);
    expect(result).toEqual({
      ok: true,
      draft: { id: "DrNew", destinations: [{ channel_id: "C11111111" }] },
    });
  });

  test("rejects --broadcast without a thread", async () => {
    const calls: Call[] = [];
    const ctx = createContext(calls);

    await expect(
      createDraftAction({
        ctx,
        targetInput: "C11111111",
        text: "hello",
        options: { workspace: "https://workspace.slack.com", broadcast: true },
      }),
    ).rejects.toThrow(/--broadcast requires a thread/);
    expect(calls.some((c) => c.method === "drafts.create")).toBe(false);
  });

  test("rejects --broadcast for a DM (user) target", async () => {
    const calls: Call[] = [];
    const ctx = createContext(calls);

    await expect(
      createDraftAction({
        ctx,
        targetInput: "W12345678",
        text: "hello",
        options: {
          workspace: "https://workspace.slack.com",
          threadTs: "1700000000.100000",
          broadcast: true,
        },
      }),
    ).rejects.toThrow(/not supported for DM targets/);
    expect(calls.some((c) => c.method === "drafts.create")).toBe(false);
  });

  test("rejects --broadcast for a D... channel-id (DM) target", async () => {
    const calls: Call[] = [];
    const ctx = createContext(calls);

    await expect(
      createDraftAction({
        ctx,
        targetInput: "D12345678",
        text: "hello",
        options: {
          workspace: "https://workspace.slack.com",
          threadTs: "1700000000.100000",
          broadcast: true,
        },
      }),
    ).rejects.toThrow(/not supported for DM targets/);
    expect(calls.some((c) => c.method === "drafts.create")).toBe(false);
  });

  test("rejects --broadcast on a channel name with no thread before any network call", async () => {
    const calls: Call[] = [];
    const ctx = createContext(calls);

    await expect(
      createDraftAction({
        ctx,
        targetInput: "general",
        text: "x",
        options: { workspace: "https://workspace.slack.com", broadcast: true },
      }),
    ).rejects.toThrow(/--broadcast requires a thread/);
    // The real problem (no thread) is reported without a channel-resolution round-trip.
    expect(calls.length).toBe(0);
  });

  test("rejects --broadcast on a DM message URL before fetching the message", async () => {
    const calls: Call[] = [];
    const ctx = createContext(calls);

    await expect(
      createDraftAction({
        ctx,
        targetInput: "https://workspace.slack.com/archives/D12345678/p1700000000100000",
        text: "x",
        options: { broadcast: true },
      }),
    ).rejects.toThrow(/not supported for DM targets/);
    expect(calls.length).toBe(0);
  });
});

describe("updateDraftAction", () => {
  const threadedBroadcastDraft = {
    id: "Dr123",
    blocks: [],
    destinations: [{ channel_id: "C11111111", thread_ts: "1700000000.100000", broadcast: true }],
    last_updated_ts: "1700000000.123",
    file_ids: ["F1", "F2"],
  };

  test("text-only edit preserves destination, thread, broadcast, and file ids", async () => {
    const calls: Call[] = [];
    const ctx = createContext(calls, { draftsList: [threadedBroadcastDraft] });

    await updateDraftAction({
      ctx,
      draftId: "Dr123",
      text: "revised",
      options: { workspace: "https://workspace.slack.com" },
    });

    const update = draftsUpdateCall(calls);
    // conflict-detection ts is auto-fetched and padded to 7 fractional digits.
    expect(update.params.client_last_updated_ts).toBe("1700000000.1230000");
    expect(update.params.destinations).toEqual([
      { channel_id: "C11111111", thread_ts: "1700000000.100000", broadcast: true },
    ]);
    expect(update.params.file_ids).toEqual(["F1", "F2"]);
  });

  test("re-addressing a broadcast thread draft to a non-thread channel clears broadcast instead of erroring", async () => {
    const calls: Call[] = [];
    const ctx = createContext(calls, { draftsList: [threadedBroadcastDraft] });

    // Regression: an inherited broadcast flag must not become a one-way ratchet
    // that fails the "broadcast requires a thread" guard on a non-thread target.
    await updateDraftAction({
      ctx,
      draftId: "Dr123",
      text: "revised",
      options: { workspace: "https://workspace.slack.com", channel: "C99999999" },
    });

    const update = draftsUpdateCall(calls);
    expect(update.params.destinations).toEqual([{ channel_id: "C99999999" }]);
  });

  test("explicit --broadcast on a non-thread draft still errors", async () => {
    const calls: Call[] = [];
    const ctx = createContext(calls, {
      draftsList: [
        {
          id: "Dr123",
          blocks: [],
          destinations: [{ channel_id: "C11111111" }],
          last_updated_ts: "1700000000.5",
        },
      ],
    });

    await expect(
      updateDraftAction({
        ctx,
        draftId: "Dr123",
        text: "revised",
        options: { workspace: "https://workspace.slack.com", broadcast: true },
      }),
    ).rejects.toThrow(/--broadcast requires a thread/);
    expect(calls.some((c) => c.method === "drafts.update")).toBe(false);
  });

  test("refuses to update a scheduled draft rather than clearing its schedule", async () => {
    const calls: Call[] = [];
    const ctx = createContext(calls, {
      draftsList: [
        {
          id: "Dr123",
          blocks: [],
          destinations: [{ channel_id: "C11111111" }],
          last_updated_ts: "1700000000.5",
          date_scheduled: 1800000000,
        },
      ],
    });

    await expect(
      updateDraftAction({
        ctx,
        draftId: "Dr123",
        text: "revised",
        options: { workspace: "https://workspace.slack.com" },
      }),
    ).rejects.toThrow(/scheduled send time/);
    expect(calls.some((c) => c.method === "drafts.update")).toBe(false);
  });

  test("refuses a text-only update on a multi-destination draft, but allows re-addressing", async () => {
    const multiDest = {
      id: "Dr123",
      blocks: [],
      destinations: [{ channel_id: "C11111111" }, { channel_id: "C22222222" }],
      last_updated_ts: "1700000000.5",
    };

    // Text-only: would drop the second recipient — must throw.
    const calls1: Call[] = [];
    await expect(
      updateDraftAction({
        ctx: createContext(calls1, { draftsList: [multiDest] }),
        draftId: "Dr123",
        text: "revised",
        options: { workspace: "https://workspace.slack.com" },
      }),
    ).rejects.toThrow(/multiple destinations/);
    expect(calls1.some((c) => c.method === "drafts.update")).toBe(false);

    // Explicit re-address is an intentional single-destination move — allowed.
    const calls2: Call[] = [];
    await updateDraftAction({
      ctx: createContext(calls2, { draftsList: [multiDest] }),
      draftId: "Dr123",
      text: "revised",
      options: { workspace: "https://workspace.slack.com", channel: "C99999999" },
    });
    expect(draftsUpdateCall(calls2).params.destinations).toEqual([{ channel_id: "C99999999" }]);
  });

  test("re-addressing to a different thread does not inherit the old broadcast flag", async () => {
    const calls: Call[] = [];
    const ctx = createContext(calls, { draftsList: [threadedBroadcastDraft] });

    await updateDraftAction({
      ctx,
      draftId: "Dr123",
      text: "revised",
      options: {
        workspace: "https://workspace.slack.com",
        channel: "C22222222",
        threadTs: "1700000000.200000",
      },
    });

    // Regression: --channel resets broadcast to explicit-only, so moving to a
    // new thread must not carry broadcast:true from the old destination.
    expect(draftsUpdateCall(calls).params.destinations).toEqual([
      { channel_id: "C22222222", thread_ts: "1700000000.200000", broadcast: false },
    ]);
  });

  test("--no-broadcast clears an inherited broadcast flag on a same-thread edit", async () => {
    const calls: Call[] = [];
    const ctx = createContext(calls, { draftsList: [threadedBroadcastDraft] });

    await updateDraftAction({
      ctx,
      draftId: "Dr123",
      text: "revised",
      options: { workspace: "https://workspace.slack.com", broadcast: false },
    });

    expect(draftsUpdateCall(calls).params.destinations).toEqual([
      { channel_id: "C11111111", thread_ts: "1700000000.100000", broadcast: false },
    ]);
  });

  test("rejects --broadcast when re-addressing to a DM (user) target", async () => {
    const calls: Call[] = [];
    const ctx = createContext(calls, { draftsList: [threadedBroadcastDraft] });

    await expect(
      updateDraftAction({
        ctx,
        draftId: "Dr123",
        text: "revised",
        options: {
          workspace: "https://workspace.slack.com",
          channel: "W12345678",
          broadcast: true,
        },
      }),
    ).rejects.toThrow(/not supported for DM targets/);
    // Fail-fast: the static re-address guard rejects before any network call
    // (no findDraft / drafts.list), so nothing is sent to the client.
    expect(calls).toEqual([]);
  });

  test("changing only --thread-ts (no --channel) does not inherit the old broadcast flag", async () => {
    const calls: Call[] = [];
    const ctx = createContext(calls, { draftsList: [threadedBroadcastDraft] });

    await updateDraftAction({
      ctx,
      draftId: "Dr123",
      text: "moved",
      options: { workspace: "https://workspace.slack.com", threadTs: "1700000000.200000" },
    });

    // Moving to a different thread is a destination change, so broadcast resets
    // to explicit-only (here: unset) rather than carrying broadcast:true over.
    expect(draftsUpdateCall(calls).params.destinations).toEqual([
      { channel_id: "C11111111", thread_ts: "1700000000.200000", broadcast: false },
    ]);
  });

  test("rejects --broadcast on an existing DM-destination draft", async () => {
    const calls: Call[] = [];
    const ctx = createContext(calls, {
      draftsList: [
        {
          id: "Dr123",
          blocks: [],
          destinations: [{ channel_id: "D12345678", thread_ts: "1700000000.100000" }],
          last_updated_ts: "1700000000.5",
        },
      ],
    });

    await expect(
      updateDraftAction({
        ctx,
        draftId: "Dr123",
        text: "revised",
        options: { workspace: "https://workspace.slack.com", broadcast: true },
      }),
    ).rejects.toThrow(/not supported for DM targets/);
    expect(calls.some((c) => c.method === "drafts.update")).toBe(false);
  });

  test("rejects --broadcast when re-addressing to a channel name with no thread, before resolving it", async () => {
    const calls: Call[] = [];
    const ctx = createContext(calls, {
      draftsList: [
        {
          id: "Dr123",
          blocks: [],
          destinations: [{ channel_id: "C11111111" }],
          last_updated_ts: "1700000000.5",
        },
      ],
    });

    await expect(
      updateDraftAction({
        ctx,
        draftId: "Dr123",
        text: "x",
        options: { workspace: "https://workspace.slack.com", channel: "general", broadcast: true },
      }),
    ).rejects.toThrow(/--broadcast requires a thread/);
    // findDraft (drafts.list) runs, but no channel-name resolution round-trip.
    expect(calls.some((c) => c.method === "search.messages")).toBe(false);
  });
});

describe("deleteDraftAction", () => {
  test("auto-fetches and pads last_updated_ts when omitted", async () => {
    const calls: Call[] = [];
    const ctx = createContext(calls, {
      draftsList: [
        {
          id: "Dr123",
          blocks: [],
          destinations: [{ channel_id: "C11111111" }],
          last_updated_ts: "1700000000.42",
        },
      ],
    });

    const result = await deleteDraftAction({
      ctx,
      draftId: "Dr123",
      options: { workspace: "https://workspace.slack.com" },
    });

    const del = calls.find((c) => c.method === "drafts.delete");
    expect(del?.params).toEqual({
      draft_id: "Dr123",
      client_last_updated_ts: "1700000000.4200000",
    });
    expect(result).toEqual({ ok: true, draft_id: "Dr123" });
  });
});

describe("listDraftsAction", () => {
  test("hydrates channel display names", async () => {
    const calls: Call[] = [];
    const ctx = createContext(calls, {
      draftsList: [
        {
          id: "Dr123",
          blocks: [],
          destinations: [{ channel_id: "C11111111" }],
          last_updated_ts: "1700000000.1",
        },
      ],
      channelInfo: { C11111111: { id: "C11111111", name: "general" } },
    });

    const result = (await listDraftsAction({
      ctx,
      options: { workspace: "https://workspace.slack.com" },
    })) as { ok: boolean; count: number; drafts: { destinations: { channel_name?: string }[] }[] };

    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(result.drafts[0]?.destinations[0]?.channel_name).toBe("general");
  });
});

describe("message draft update (commander --broadcast wiring)", () => {
  const threadedBroadcast = {
    id: "Dr123",
    blocks: [],
    destinations: [{ channel_id: "C11111111", thread_ts: "1700000000.100000", broadcast: true }],
    last_updated_ts: "1700000000.5",
  };
  const threadedPlain = {
    id: "Dr123",
    blocks: [],
    destinations: [{ channel_id: "C11111111", thread_ts: "1700000000.100000" }],
    last_updated_ts: "1700000000.5",
  };

  async function runUpdate(flags: string[], draft: Record<string, unknown>): Promise<Call[]> {
    const calls: Call[] = [];
    const program = new Command();
    program.exitOverride();
    const messageCmd = program.command("message");
    registerMessageDraftCommand({ ctx: createContext(calls, { draftsList: [draft] }), messageCmd });
    await program.parseAsync([
      "node",
      "agent-slack",
      "message",
      "draft",
      "update",
      "Dr123",
      "revised",
      "--workspace",
      "https://workspace.slack.com",
      ...flags,
    ]);
    return calls;
  }

  test("omitting broadcast flags does not force broadcast on (no Commander default-true gotcha)", async () => {
    const calls = await runUpdate([], threadedPlain);
    // If defining --no-broadcast had made `broadcast` default to true, this
    // non-broadcast draft would be silently promoted on a plain text edit.
    expect(draftsUpdateCall(calls).params.destinations).toEqual([
      { channel_id: "C11111111", thread_ts: "1700000000.100000", broadcast: false },
    ]);
  });

  test("--broadcast sets broadcast true", async () => {
    const calls = await runUpdate(["--broadcast"], threadedPlain);
    expect(draftsUpdateCall(calls).params.destinations).toEqual([
      { channel_id: "C11111111", thread_ts: "1700000000.100000", broadcast: true },
    ]);
  });

  test("--no-broadcast clears an inherited broadcast flag", async () => {
    const calls = await runUpdate(["--no-broadcast"], threadedBroadcast);
    expect(draftsUpdateCall(calls).params.destinations).toEqual([
      { channel_id: "C11111111", thread_ts: "1700000000.100000", broadcast: false },
    ]);
  });
});

describe("message draft unknown subcommand", () => {
  test("old `message draft <target>` usage points to `message compose`", () => {
    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(" "));
    });
    const prevExit = process.exitCode;
    try {
      const program = new Command();
      program.exitOverride();
      const messageCmd = program.command("message");
      registerMessageDraftCommand({ ctx: createContext([]), messageCmd });
      program.parse(["node", "agent-slack", "message", "draft", "#general", "hi"]);
    } finally {
      spy.mockRestore();
    }
    const joined = errors.join("\n");
    expect(joined).toMatch(/not a 'message draft' subcommand/);
    expect(joined).toContain("message compose");
    expect(process.exitCode).toBe(1);
    // Don't leak a failing exit code into the test runner.
    process.exitCode = prevExit;
  });
});
