import { describe, expect, test } from "bun:test";
import { parseInviteUsersCsv, splitEmailsFromInviteTargets } from "../src/slack/channel-admin.ts";

describe("parseInviteUsersCsv", () => {
  test("splits comma-separated values, trims whitespace, and deduplicates", () => {
    const users = parseInviteUsersCsv(" U01AAAA , @alice, bob@example.com, @alice ,, ");
    expect(users).toEqual(["U01AAAA", "@alice", "bob@example.com"]);
  });

  test("returns empty array when input has no values", () => {
    expect(parseInviteUsersCsv(" , , ")).toEqual([]);
  });
});

describe("splitEmailsFromInviteTargets", () => {
  test("separates email targets from non-email targets", () => {
    const split = splitEmailsFromInviteTargets([
      "alice@example.com",
      "@alice",
      "U01AAAA",
      "bob@example.com",
    ]);
    expect(split.emails).toEqual(["alice@example.com", "bob@example.com"]);
    expect(split.non_email_targets).toEqual(["@alice", "U01AAAA"]);
  });

  test("deduplicates emails", () => {
    const split = splitEmailsFromInviteTargets(["alice@example.com", "alice@example.com"]);
    expect(split.emails).toEqual(["alice@example.com"]);
  });
});
