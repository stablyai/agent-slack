import { describe, expect, test } from "bun:test";
import { parseInviteUsersCsv } from "../src/slack/channel-admin.ts";

describe("parseInviteUsersCsv", () => {
  test("splits comma-separated values, trims whitespace, and deduplicates", () => {
    const users = parseInviteUsersCsv(" U01AAAA , @alice, bob@example.com, @alice ,, ");
    expect(users).toEqual(["U01AAAA", "@alice", "bob@example.com"]);
  });

  test("returns empty array when input has no values", () => {
    expect(parseInviteUsersCsv(" , , ")).toEqual([]);
  });
});
