import { describe, expect, test } from "bun:test";
import {
  incompleteStrictUserResolution,
  resolveStrictUserIdentities,
  StrictUserDirectoryRequestError,
} from "../src/slack/strict-user-resolution.ts";
import { formatOutboundSlackText } from "../src/slack/format-outbound.ts";
import { activeUser, createClient } from "./strict-user-resolution-fixtures.ts";

describe("strict user resolution safety evidence", () => {
  test("marks relevant unknown eligibility as incomplete", async () => {
    const user = activeUser("U11111111", { name: "alice" });
    delete user.deleted;
    const { client } = createClient([{ members: [user] }]);

    const result = await resolveStrictUserIdentities({
      client,
      identities: ["@alice"],
    });

    expect(result).toEqual({
      directory: {
        status: "incomplete",
        pages: 1,
        reason: "eligibility_unknown",
      },
      safe_to_mention: false,
      results: [],
    });
  });

  test("does not let unrelated unknown eligibility contaminate an exact match", async () => {
    const unknown = activeUser("U11111111", { name: "other" });
    delete unknown.deleted;
    delete unknown.is_bot;
    const { client } = createClient([
      {
        members: [unknown, activeUser("U22222222", { name: "alice" })],
      },
    ]);

    const result = await resolveStrictUserIdentities({
      client,
      identities: ["@alice"],
    });

    expect(result.safe_to_mention).toBe(true);
    expect(result.results[0]).toMatchObject({
      status: "resolved",
      mention: "<@U22222222>",
    });
  });

  test("deduplicates compatible repeated records for one canonical user", async () => {
    const { client } = createClient([
      {
        members: [activeUser("U11111111", { name: "alice" })],
        response_metadata: { next_cursor: "cursor-1" },
      },
      {
        members: [{ id: "U11111111", name: "alice", deleted: false, is_bot: false }],
      },
    ]);

    const result = await resolveStrictUserIdentities({
      client,
      identities: ["alice"],
    });

    expect(result.safe_to_mention).toBe(true);
    expect(result.results[0]).toMatchObject({
      status: "resolved",
      mention: "<@U11111111>",
    });
  });

  test("fails incomplete on conflicting records for one canonical user", async () => {
    const { client } = createClient([
      {
        members: [activeUser("U11111111", { name: "alice" })],
        response_metadata: { next_cursor: "cursor-1" },
      },
      {
        members: [activeUser("U11111111", { name: "alicia" })],
      },
    ]);

    const result = await resolveStrictUserIdentities({
      client,
      identities: ["alice"],
    });

    expect(result.directory).toEqual({
      status: "incomplete",
      pages: 2,
      reason: "user_conflict",
    });
    expect(result.results).toEqual([]);
  });

  test("detects repeated and malformed cursors while keeping cursors opaque", async () => {
    const repeated = createClient([
      { members: [], response_metadata: { next_cursor: "same" } },
      { members: [], response_metadata: { next_cursor: "same" } },
    ]);
    const repeatedResult = await resolveStrictUserIdentities({
      client: repeated.client,
      identities: ["alice"],
    });
    expect(repeatedResult.directory).toEqual({
      status: "incomplete",
      pages: 2,
      reason: "cursor_repeated",
    });

    const malformed = createClient([{ members: [], response_metadata: { next_cursor: 123 } }]);
    const malformedResult = await resolveStrictUserIdentities({
      client: malformed.client,
      identities: ["alice"],
    });
    expect(malformedResult.directory).toEqual({
      status: "incomplete",
      pages: 1,
      reason: "cursor_invalid",
    });

    for (const response_metadata of [null, { next_cursor: null }]) {
      const invalidNull = createClient([{ members: [], response_metadata }]);
      const invalidNullResult = await resolveStrictUserIdentities({
        client: invalidNull.client,
        identities: ["alice"],
      });
      expect(invalidNullResult.directory).toEqual({
        status: "incomplete",
        pages: 1,
        reason: "cursor_invalid",
      });
    }

    const opaque = createClient([
      { members: [], response_metadata: { next_cursor: "invalid" } },
      { members: [activeUser("U11111111", { name: "alice" })] },
    ]);
    const opaqueResult = await resolveStrictUserIdentities({
      client: opaque.client,
      identities: ["alice"],
    });
    expect(opaque.calls[1]?.params.cursor).toBe("invalid");
    expect(opaqueResult.safe_to_mention).toBe(true);
  });

  test("treats malformed relevant user fields as incomplete", async () => {
    const { client } = createClient([
      {
        members: [
          {
            id: "U11111111",
            name: ["alice"],
            deleted: false,
            is_bot: false,
          },
        ],
      },
    ]);

    const result = await resolveStrictUserIdentities({
      client,
      identities: ["@alice"],
    });

    expect(result.directory).toEqual({
      status: "incomplete",
      pages: 1,
      reason: "user_invalid",
    });
  });

  test("has no arbitrary page-count cutoff", async () => {
    const pages = Array.from({ length: 61 }, (_, index) => ({
      members: [activeUser(`U${String(index).padStart(8, "0")}`, { name: `user-${index}` })],
      response_metadata: { next_cursor: `cursor-${index}` },
    }));
    pages.push({
      members: [activeUser("U99999999", { name: "target" })],
      response_metadata: { next_cursor: "" },
    });
    const { client, calls } = createClient(pages);

    const result = await resolveStrictUserIdentities({
      client,
      identities: ["@target"],
    });

    expect(calls).toHaveLength(62);
    expect(result.directory).toEqual({ status: "complete", pages: 62 });
    expect(result.safe_to_mention).toBe(true);
  });

  test("throws typed request evidence without exposing provisional matches", async () => {
    const { client } = createClient([
      {
        members: [activeUser("U11111111", { name: "alice" })],
        response_metadata: { next_cursor: "cursor-1" },
      },
      new Error("Slack API call users.list timed out after 20000ms"),
    ]);

    let caught: unknown;
    try {
      await resolveStrictUserIdentities({
        client,
        identities: ["@alice"],
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(StrictUserDirectoryRequestError);
    const requestError = caught as StrictUserDirectoryRequestError;
    expect(requestError.pages).toBe(1);
    expect(requestError.reason).toBe("request_timeout");

    const output = incompleteStrictUserResolution({
      pages: requestError.pages,
      reason: requestError.reason,
    });
    expect(output.results).toEqual([]);
    expect(JSON.stringify(output)).not.toContain("<@");
  });

  test("classifies standard and browser rate-limit errors consistently", () => {
    expect(
      new StrictUserDirectoryRequestError(new Error("Request failed with a rate-limit error"), 0)
        .reason,
    ).toBe("rate_limited");
    expect(
      new StrictUserDirectoryRequestError(new Error("Slack API was ratelimited"), 0).reason,
    ).toBe("rate_limited");
  });

  test("detects duplicate conflicts outside the requested identity field", async () => {
    const { client } = createClient([
      {
        members: [activeUser("U11111111", { name: "alice" })],
        response_metadata: { next_cursor: "cursor-1" },
      },
      {
        members: [activeUser("U11111111", { name: "alicia" })],
      },
    ]);

    const result = await resolveStrictUserIdentities({
      client,
      identities: ["U11111111"],
    });

    expect(result.directory).toEqual({
      status: "incomplete",
      pages: 2,
      reason: "user_conflict",
    });
  });

  test("makes echoed Slack control syntax inert in mixed batches", async () => {
    const { client } = createClient([
      {
        members: [
          activeUser("U11111111", {
            name: "alice",
            realName: "Alice Example",
            displayName: "Alice",
          }),
        ],
      },
    ]);

    const result = await resolveStrictUserIdentities({
      client,
      identities: ["@alice", "<@U99999999>\n<!here> @channel @everyone @W88888888"],
    });
    const output = JSON.stringify(result);

    expect(result.safe_to_mention).toBe(false);
    expect(output).not.toContain("<@");
    expect(output).not.toContain("<!");
    expect(result.results[1]?.source).toBe(
      "‹＠U99999999> ‹!here> ＠channel ＠everyone ＠W88888888",
    );
    const outbound = formatOutboundSlackText(output);
    expect(outbound).not.toContain("<@");
    expect(outbound).not.toContain("<!");
  });
});
