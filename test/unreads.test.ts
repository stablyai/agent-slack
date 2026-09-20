import { describe, expect, test } from "bun:test";
import type { SlackApiClient } from "../src/slack/client.ts";
import { isTeamRestrictedError } from "../src/slack/api-errors.ts";
import {
  UNREADS_FALLBACK_CHANNEL_LIMIT,
  UNREADS_FALLBACK_DM_COUNT,
  fetchUnreads,
  isTsNewer,
} from "../src/slack/unreads.ts";

function createClient(
  handler: (
    method: string,
    params: Record<string, unknown>,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>,
) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const client = {
    api: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      return handler(method, params);
    },
  } as unknown as SlackApiClient;
  return { client, calls };
}

describe("isTeamRestrictedError", () => {
  test("matches a bare Error message", () => {
    expect(isTeamRestrictedError(new Error("team_is_restricted"))).toBe(true);
  });

  test("matches @slack/web-api wrapping", () => {
    const err = new Error("An API error occurred: team_is_restricted") as Error & {
      data: { error: string };
    };
    err.data = { error: "team_is_restricted" };
    expect(isTeamRestrictedError(err)).toBe(true);
  });

  test("ignores unrelated errors", () => {
    expect(isTeamRestrictedError(new Error("channel_not_found"))).toBe(false);
  });
});

describe("fetchUnreads", () => {
  test("uses client.counts as the primary path", async () => {
    const { client, calls } = createClient((method) => {
      if (method === "client.counts") {
        return {
          channels: [
            {
              id: "C1",
              has_unreads: true,
              unread_count_display: 2,
              mention_count: 1,
              last_read: "1.0",
            },
          ],
          mpims: [],
          ims: [],
          threads: { has_unreads: true, mention_count: 3 },
        };
      }
      if (method === "conversations.info") {
        return { channel: { id: "C1", name: "general", is_channel: true } };
      }
      if (method === "conversations.history") {
        return {
          messages: [
            { ts: "1.1", user: "U1", text: "hi" },
            { ts: "1.2", user: "U2", text: "there" },
          ],
        };
      }
      throw new Error(`unexpected ${method}`);
    });

    const result = await fetchUnreads(client, { includeMessages: true });

    expect(calls[0]?.method).toBe("client.counts");
    expect(calls.some((c) => c.method === "client.dms")).toBe(false);
    expect(result.threads).toEqual({ has_unreads: true, mention_count: 3 });
    expect(result.channels).toHaveLength(1);
    expect(result.channels[0]?.channel_name).toBe("general");
    expect(result.channels[0]?.unread_count).toBe(2);
    expect(result.channels[0]?.messages).toHaveLength(2);
  });

  test("does not fall back on unrelated client.counts errors", async () => {
    const { client } = createClient(() => {
      throw new Error("fatal_error");
    });
    await expect(fetchUnreads(client)).rejects.toThrow("fatal_error");
  });

  test("falls back when client.counts is team_is_restricted", async () => {
    const { client, calls } = createClient((method, params) => {
      if (method === "client.counts") {
        throw new Error("team_is_restricted");
      }
      if (method === "client.dms") {
        expect(params.count).toBe(UNREADS_FALLBACK_DM_COUNT);
        return {
          ims: [{ id: "D1", message: { ts: "20.0", user: "U9", text: "ping" } }],
          mpims: [{ id: "G1", message: { ts: "19.0", user: "U8", text: "group" } }],
        };
      }
      if (method === "users.conversations") {
        expect(params.limit).toBe(UNREADS_FALLBACK_CHANNEL_LIMIT);
        expect(params.types).toBe("public_channel,private_channel");
        return {
          channels: [
            { id: "C1", name: "alerts", updated: 50 },
            { id: "C2", name: "old", updated: 10 },
          ],
        };
      }
      if (method === "conversations.info") {
        const id = params.channel as string;
        if (id === "D1") {
          return { channel: { id, is_im: true, user: "U9", last_read: "10.0" } };
        }
        if (id === "G1") {
          return { channel: { id, is_mpim: true, last_read: "19.0" } };
        }
        if (id === "C1") {
          return { channel: { id, name: "alerts", is_channel: true, last_read: "1.0" } };
        }
        return { channel: { id, name: "old", is_channel: true, last_read: "30.0" } };
      }
      if (method === "users.info") {
        return { user: { id: "U9", profile: { display_name: "Ada" } } };
      }
      if (method === "conversations.history") {
        const id = params.channel as string;
        if (id === "D1") {
          return { messages: [{ ts: "20.0", user: "U9", text: "ping" }] };
        }
        if (id === "C1") {
          return { messages: [{ ts: "5.0", user: "U2", text: "alert" }] };
        }
        if (id === "C2") {
          return { messages: [{ ts: "2.0", user: "U3", text: "stale" }] };
        }
        return { messages: [] };
      }
      throw new Error(`unexpected ${method}`);
    });

    const result = await fetchUnreads(client, { includeMessages: true });

    expect(calls[0]?.method).toBe("client.counts");
    expect(calls.some((c) => c.method === "client.dms")).toBe(true);
    expect(calls.some((c) => c.method === "users.conversations")).toBe(true);
    expect(result.threads).toBeNull();
    expect(result.channels.map((c) => c.channel_id).sort()).toEqual(["C1", "D1"]);
    const dm = result.channels.find((c) => c.channel_id === "D1");
    expect(dm?.channel_type).toBe("dm");
    expect(dm?.channel_name).toBe("Ada");
    expect(dm?.messages?.[0]?.content).toBe("ping");
    const readMpim = result.channels.find((c) => c.channel_id === "G1");
    expect(readMpim).toBeUndefined();
  });

  test("counts-only fallback keeps the DM path bounded to client.dms plus info", async () => {
    const { client, calls } = createClient((method) => {
      if (method === "client.counts") {
        throw Object.assign(new Error("An API error occurred: team_is_restricted"), {
          data: { error: "team_is_restricted" },
        });
      }
      if (method === "client.dms") {
        return {
          ims: [
            { id: "D1", message: { ts: "2.0", text: "new" } },
            { id: "D2", message: { ts: "1.0", text: "old" } },
          ],
          mpims: [],
        };
      }
      if (method === "users.conversations") {
        return { channels: [] };
      }
      if (method === "conversations.info") {
        return { channel: { id: "D1", is_im: true, last_read: "1.5" } };
      }
      throw new Error(`unexpected ${method}`);
    });

    const result = await fetchUnreads(client, { includeMessages: false });

    expect(calls.filter((c) => c.method === "client.dms")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "conversations.info")).toHaveLength(2);
    expect(calls.some((c) => c.method === "conversations.history")).toBe(false);
    expect(result.channels).toHaveLength(1);
    expect(result.channels[0]?.channel_id).toBe("D1");
    expect(result.channels[0]?.messages).toBeUndefined();
    expect(result.channels[0]?.unread_count).toBe(1);
  });

  test("caps client.dms count so the IM list is not swept", async () => {
    const { client, calls } = createClient((method) => {
      if (method === "client.counts") {
        throw new Error("team_is_restricted");
      }
      if (method === "client.dms") {
        return { ims: [], mpims: [] };
      }
      if (method === "users.conversations") {
        return { channels: [] };
      }
      throw new Error(`unexpected ${method}`);
    });

    await fetchUnreads(client, { includeMessages: false });
    const dmsCall = calls.find((c) => c.method === "client.dms");
    expect(dmsCall?.params.count).toBe(UNREADS_FALLBACK_DM_COUNT);
    expect(UNREADS_FALLBACK_DM_COUNT).toBeLessThanOrEqual(50);
  });
});

describe("isTsNewer", () => {
  test("treats a missing last_read as unread when a latest ts exists", () => {
    expect(isTsNewer("1.2", undefined)).toBe(true);
    expect(isTsNewer("1.2", "0")).toBe(true);
    expect(isTsNewer("1.2", "1.2")).toBe(false);
    expect(isTsNewer("1.3", "1.2")).toBe(true);
  });
});
