import { describe, expect, test } from "bun:test";
import { fetchThread } from "../src/slack/messages.ts";

describe("fetchThread", () => {
  test("returns the thread root and replies in chronological order", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const client = {
      api: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        return {
          messages: [
            { ts: "2.000002", thread_ts: "1.000001", text: "reply", user: "U22222222" },
            { ts: "1.000001", text: "root", user: "U11111111" },
          ],
        };
      },
    };

    const messages = await fetchThread(client as never, {
      channelId: "C12345678",
      threadTs: "1.000001",
    });

    expect(calls).toEqual([
      {
        method: "conversations.replies",
        params: {
          channel: "C12345678",
          ts: "1.000001",
          limit: 200,
          cursor: undefined,
          include_all_metadata: undefined,
        },
      },
    ]);
    expect(messages.map(({ ts, text }) => ({ ts, text }))).toEqual([
      { ts: "1.000001", text: "root" },
      { ts: "2.000002", text: "reply" },
    ]);
  });
});
