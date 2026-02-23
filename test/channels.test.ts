import { describe, expect, test } from "bun:test";
import {
  listAllConversations,
  listUserConversations,
  normalizeConversationsPage,
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
});
