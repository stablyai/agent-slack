import { describe, expect, test } from "bun:test";
import {
  listAllConversations,
  listConversationsViaCounts,
  listUserConversations,
  normalizeConversationsPage,
  resolveChannelId,
} from "../src/slack/channels.ts";
import type { SlackApiClient } from "../src/slack/client.ts";

function createClient(response: Record<string, unknown>) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const client = {
    api: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return response;
    },
  } as unknown as SlackApiClient;
  return { client, calls };
}

describe("conversations list helpers", () => {
  test("listUserConversations calls users.conversations with defaults", async () => {
    const { client, calls } = createClient({ channels: [] });

    await listUserConversations(client, {});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("users.conversations");
    expect(calls[0]?.params).toEqual({
      types: "public_channel,private_channel,im,mpim",
      exclude_archived: true,
      limit: 100,
      cursor: undefined,
      user: undefined,
    });
  });

  test("listUserConversations forwards user/limit/cursor", async () => {
    const { client, calls } = createClient({ channels: [] });

    await listUserConversations(client, { user: "U123", limit: 77, cursor: "abc" });

    expect(calls[0]?.params).toEqual({
      user: "U123",
      limit: 77,
      cursor: "abc",
      types: "public_channel,private_channel,im,mpim",
      exclude_archived: true,
    });
  });

  test("listAllConversations calls conversations.list with defaults", async () => {
    const { client, calls } = createClient({ channels: [] });

    await listAllConversations(client, {});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("conversations.list");
    expect(calls[0]?.params).toEqual({
      types: "public_channel,private_channel,im,mpim",
      exclude_archived: true,
      limit: 100,
      cursor: undefined,
    });
  });

  test("listAllConversations forwards limit/cursor", async () => {
    const { client, calls } = createClient({ channels: [] });
    await listAllConversations(client, { limit: 50, cursor: "xyz" });
    expect(calls[0]?.params).toEqual({
      types: "public_channel,private_channel,im,mpim",
      exclude_archived: true,
      limit: 50,
      cursor: "xyz",
    });
  });

  test("listUserConversations passes through small limits", async () => {
    const { client, calls } = createClient({ channels: [] });

    await listUserConversations(client, { limit: 3 });

    expect(calls[0]?.params.limit).toBe(3);
  });

  test("listUserConversations clamps high limits to 1000", async () => {
    const { client, calls } = createClient({ channels: [] });
    await listUserConversations(client, { limit: 5000 });
    expect(calls[0]?.params.limit).toBe(1000);
  });

  test("normalizeConversationsPage extracts channels and next cursor", () => {
    const normalized = normalizeConversationsPage({
      channels: [{ id: "C1" }, { id: "D1" }],
      response_metadata: { next_cursor: "next123" },
    });

    expect(normalized.channels).toHaveLength(2);
    expect(normalized.next_cursor).toBe("next123");
  });

  test("normalizeConversationsPage handles missing response_metadata", () => {
    const normalized = normalizeConversationsPage({ channels: [] });
    expect(normalized.channels).toHaveLength(0);
    expect(normalized.next_cursor).toBeUndefined();
  });

  test("normalizeConversationsPage handles empty next_cursor", () => {
    const normalized = normalizeConversationsPage({
      channels: [],
      response_metadata: { next_cursor: "" },
    });
    // Empty string from getString - falsy so consumers can check `if (page.next_cursor)`
    expect(normalized.next_cursor).toBeFalsy();
  });

  test("listConversationsViaCounts enumerates channels/mpims/ims and enriches via conversations.info", async () => {
    const countsResponse = {
      channels: [{ id: "C1", has_unreads: true }],
      mpims: [{ id: "G1" }],
      ims: [{ id: "D1" }],
    };
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const client = {
      api: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "client.counts") {
          return countsResponse;
        }
        if (method === "conversations.info") {
          const id = params.channel as string;
          return { channel: { id, name: `name-${id}`, is_channel: id.startsWith("C") } };
        }
        throw new Error(`unexpected method: ${method}`);
      },
    } as unknown as SlackApiClient;

    const page = await listConversationsViaCounts(client, { limit: 100 });

    expect(calls[0]?.method).toBe("client.counts");
    expect(calls[0]?.params).toEqual({ thread_count_by_channel: true });
    const infoCalls = calls.filter((c) => c.method === "conversations.info");
    expect(infoCalls).toHaveLength(3);
    expect(infoCalls.map((c) => c.params.channel)).toEqual(["C1", "G1", "D1"]);
    expect(page.next_cursor).toBeUndefined();
    expect(page.channels).toHaveLength(3);
    expect(page.channels.map((c) => c.id)).toEqual(["C1", "G1", "D1"]);
    expect(page.channels[0]?.name).toBe("name-C1");
  });

  test("listConversationsViaCounts keeps the id when conversations.info fails", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const client = {
      api: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "client.counts") {
          return { channels: [{ id: "C1" }], mpims: [], ims: [] };
        }
        if (method === "conversations.info") {
          throw new Error("channel_not_found");
        }
        throw new Error(`unexpected method: ${method}`);
      },
    } as unknown as SlackApiClient;

    const page = await listConversationsViaCounts(client, { limit: 100 });
    expect(page.channels).toEqual([{ id: "C1" }]);
  });

  test("listConversationsViaCounts slices to limit and skips entries without an id", async () => {
    const countsResponse = {
      channels: [{ id: "C1" }, { no_id: true }, { id: "C2" }, { id: "C3" }],
      mpims: [],
      ims: [],
    };
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const client = {
      api: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "client.counts") {
          return countsResponse;
        }
        if (method === "conversations.info") {
          return { channel: { id: params.channel } };
        }
        throw new Error(`unexpected method: ${method}`);
      },
    } as unknown as SlackApiClient;

    const page = await listConversationsViaCounts(client, { limit: 2 });
    const infoCalls = calls.filter((c) => c.method === "conversations.info");
    expect(infoCalls).toHaveLength(2);
    expect(page.channels.map((c) => c.id)).toEqual(["C1", "C2"]);
  });
});

describe("resolveChannelId", () => {
  type Handler = () => Record<string, unknown>;

  function createScriptedClient(handlers: Record<string, Handler>) {
    const calls: string[] = [];
    const client = {
      api: async (method: string) => {
        calls.push(method);
        const handler = handlers[method];
        if (!handler) {
          throw new Error(`unexpected method: ${method}`);
        }
        return handler();
      },
    } as unknown as SlackApiClient;
    return { client, calls };
  }

  const fail = (message: string) => () => {
    throw new Error(message);
  };
  const noMatch = () => ({ messages: { matches: [] } });

  test("resolves a name from the first search.messages match", async () => {
    const { client, calls } = createScriptedClient({
      "search.messages": () => ({ messages: { matches: [{ channel: { id: "C12345678" } }] } }),
    });

    expect(await resolveChannelId(client, "#general")).toBe("C12345678");
    expect(calls).toEqual(["search.messages"]);
  });

  test("falls back to conversations.list when search fails", async () => {
    const { client } = createScriptedClient({
      "search.messages": fail("missing_scope"),
      "conversations.list": () => ({ channels: [{ id: "C99999999", name: "general" }] }),
    });

    expect(await resolveChannelId(client, "#general")).toBe("C99999999");
  });

  test("names the channel when search finds nothing and conversations.list is restricted", async () => {
    const { client } = createScriptedClient({
      "search.messages": noMatch,
      "conversations.list": fail("enterprise_is_restricted"),
    });

    await expect(resolveChannelId(client, "#general")).rejects.toThrow(
      "Could not resolve channel name: #general; conversations.list failed: enterprise_is_restricted",
    );
  });

  test("reports the search error when the conversations.list fallback also fails", async () => {
    const { client } = createScriptedClient({
      "search.messages": fail("missing_scope"),
      "conversations.list": fail("enterprise_is_restricted"),
    });

    const error = await resolveChannelId(client, "#general").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Could not resolve channel name: #general (search.messages failed: missing_scope); conversations.list failed: enterprise_is_restricted",
    );
    expect(((error as Error).cause as Error).message).toBe("enterprise_is_restricted");
  });

  test("reports the search error when conversations.list has no match either", async () => {
    const { client } = createScriptedClient({
      "search.messages": fail("missing_scope"),
      "conversations.list": () => ({ channels: [] }),
    });

    await expect(resolveChannelId(client, "#general")).rejects.toThrow(
      "Could not resolve channel name: #general (search.messages failed: missing_scope)",
    );
  });
});
