import { describe, expect, test } from "bun:test";
import { toCompactMessage, type SlackMessageSummary } from "../src/slack/messages.ts";

describe("reactions compaction", () => {
  test("includes reactions only when enabled", () => {
    const msg: SlackMessageSummary = {
      channel_id: "C1",
      ts: "1.000001",
      text: "hi",
      markdown: "hi",
      reactions: [{ name: "rocket", users: ["U12345678", "U87654321"], count: 2 }],
    };

    const a = toCompactMessage(msg, { includeReactions: false });
    expect(a.reactions).toBeUndefined();

    const b = toCompactMessage(msg, { includeReactions: true });
    expect(b.reactions?.[0]?.name).toBe("rocket");
    expect(b.reactions?.[0]?.users?.length).toBe(2);
    expect(b.reactions?.[0]?.count).toBeUndefined();
  });

  test("adds forwarded thread metadata for shared messages with thread_ts", () => {
    const msg: SlackMessageSummary = {
      channel_id: "C1",
      ts: "1.000001",
      text: "outer",
      markdown: "outer",
      attachments: [
        {
          is_share: true,
          from_url:
            "https://example.slack.com/archives/C222/p333?thread_ts=1771564510.386389&cid=C222",
        },
      ],
    };

    const compact = toCompactMessage(msg);
    expect(compact.forwarded_threads?.length).toBe(1);
    expect(compact.forwarded_threads?.[0]?.thread_ts).toBe("1771564510.386389");
    expect(compact.forwarded_threads?.[0]?.channel_id).toBe("C222");
    expect(compact.forwarded_threads?.[0]?.has_more_replies).toBe(true);
  });
});
