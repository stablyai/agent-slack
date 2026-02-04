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
});
