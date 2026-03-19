import { describe, expect, test } from "bun:test";
import { collectReferencedUserIds, toReferencedUsers } from "../src/slack/user-cache.ts";
import type { SlackMessageSummary } from "../src/slack/messages.ts";
import type { CompactSlackUser } from "../src/slack/users.ts";

describe("user-cache helpers", () => {
  test("collectReferencedUserIds excludes reaction users by default", () => {
    const messages: SlackMessageSummary[] = [
      {
        channel_id: "C1",
        ts: "1.000001",
        text: "hey <@U22222222>",
        markdown: "hey @U22222222",
        user: "U11111111",
        reactions: [{ name: "eyes", users: ["U11111111", "U33333333"] }],
      },
      {
        channel_id: "C1",
        ts: "1.000002",
        text: "follow-up for <@U33333333> and <@U22222222>",
        markdown: "follow-up",
        user: "U11111111",
      },
    ];

    expect(collectReferencedUserIds(messages).sort()).toEqual([
      "U11111111",
      "U22222222",
      "U33333333",
    ]);
  });

  test("collectReferencedUserIds includes reaction users when enabled", () => {
    const messages: SlackMessageSummary[] = [
      {
        channel_id: "C1",
        ts: "1.000001",
        text: "hey <@U22222222>",
        markdown: "hey @U22222222",
        user: "U11111111",
        reactions: [{ name: "eyes", users: ["U11111111", "U44444444"] }],
      },
    ];

    expect(collectReferencedUserIds(messages, { includeReactions: true }).sort()).toEqual([
      "U11111111",
      "U22222222",
      "U44444444",
    ]);
  });

  test("toReferencedUsers returns only resolved users keyed by id", () => {
    const usersById = new Map<string, CompactSlackUser>([
      ["U11111111", { id: "U11111111", name: "alice", display_name: "Alice" }],
      ["U22222222", { id: "U22222222", name: "bob", display_name: "Bob" }],
    ]);

    expect(toReferencedUsers(["U11111111", "U11111111", "U99999999"], usersById)).toEqual({
      U11111111: { id: "U11111111", name: "alice", display_name: "Alice" },
    });

    expect(toReferencedUsers(["U99999999"], usersById)).toBeUndefined();
  });
});
