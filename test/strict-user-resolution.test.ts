import { describe, expect, test } from "bun:test";
import { resolveStrictUserIdentities } from "../src/slack/strict-user-resolution.ts";
import { activeUser, createClient } from "./strict-user-resolution-fixtures.ts";

describe("resolveStrictUserIdentities", () => {
  test("resolves a batch with one complete paginated directory scan", async () => {
    const { client, calls } = createClient([
      {
        members: [
          activeUser("U11111111", {
            name: "alice",
            realName: "Alice Example",
            displayName: "Alice",
            email: "alice@example.com",
          }),
          activeUser("W44444444", {
            name: "enterprise",
            extra: { is_app_user: true },
          }),
        ],
        response_metadata: { next_cursor: "cursor-1" },
      },
      {
        members: [
          activeUser("U22222222", {
            name: "bob",
            realName: "Bob Smith",
            displayName: "Bobby",
            email: "bob@example.com",
          }),
        ],
        response_metadata: { next_cursor: "" },
      },
    ]);

    const result = await resolveStrictUserIdentities({
      client,
      identities: ["@ALICE", "bob@example.com", "  Bob   Smith ", "w44444444"],
    });

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.method)).toEqual(["users.list", "users.list"]);
    expect(calls[0]?.params.cursor).toBeUndefined();
    expect(calls[1]?.params.cursor).toBe("cursor-1");
    expect(result.directory).toEqual({ status: "complete", pages: 2 });
    expect(result.safe_to_mention).toBe(true);
    expect(result.results).toEqual([
      {
        source: "@ALICE",
        status: "resolved",
        matched_by: ["input.handle->slack.name"],
        mention: "<@U11111111>",
      },
      {
        source: "bob@example.com",
        status: "resolved",
        matched_by: ["input.email->slack.profile.email"],
        mention: "<@U22222222>",
      },
      {
        source: "Bob Smith",
        status: "resolved",
        matched_by: [
          "input.full_name->slack.profile.real_name",
          "input.full_name->slack.real_name",
        ],
        mention: "<@U22222222>",
      },
      {
        source: "w44444444",
        status: "resolved",
        matched_by: ["input.id->slack.id"],
        mention: "<@W44444444>",
      },
    ]);
  });

  test("keeps a first-page match provisional until last-page ambiguity is known", async () => {
    const { client } = createClient([
      {
        members: [activeUser("U11111111", { name: "alex" })],
        response_metadata: { next_cursor: "cursor-1" },
      },
      {
        members: [activeUser("U22222222", { name: "alex" })],
        response_metadata: { next_cursor: "" },
      },
    ]);

    const result = await resolveStrictUserIdentities({
      client,
      identities: ["@alex"],
    });

    expect(result.results).toEqual([
      {
        source: "@alex",
        status: "ambiguous",
        candidate_count: 2,
      },
    ]);
    expect(result.safe_to_mention).toBe(false);
    expect(JSON.stringify(result)).not.toContain("<@");
  });

  test("ignores equality in fields that cannot authorize the input type", async () => {
    const { client } = createClient([
      {
        members: [
          activeUser("U11111111", { name: "alex", displayName: "First" }),
          activeUser("U22222222", { name: "other", displayName: "alex" }),
        ],
      },
    ]);

    const result = await resolveStrictUserIdentities({
      client,
      identities: ["@alex"],
    });

    expect(result.safe_to_mention).toBe(true);
    expect(result.results[0]).toMatchObject({
      status: "resolved",
      mention: "<@U11111111>",
    });
  });

  test("filters known non-humans while allowing is_app_user humans", async () => {
    const { client } = createClient([
      {
        members: [
          activeUser("U11111111", { name: "deleted", deleted: true }),
          activeUser("U22222222", { name: "bot", isBot: true }),
          activeUser("U33333333", {
            name: "workflow",
            extra: { is_workflow_bot: true },
          }),
          activeUser("U44444444", {
            name: "connector",
            extra: { is_connector_bot: true },
          }),
          activeUser("U55555555", {
            name: "profilebot",
            profileExtra: { bot_id: "B11111111" },
          }),
          activeUser("U66666666", {
            name: "human",
            extra: { is_app_user: true },
          }),
          activeUser("U77777777", {
            name: "profileapp",
            profileExtra: { api_app_id: "A11111111" },
          }),
          activeUser("USLACKBOT", { name: "slackbot" }),
        ],
      },
    ]);

    const result = await resolveStrictUserIdentities({
      client,
      identities: [
        "@deleted",
        "@bot",
        "@workflow",
        "@connector",
        "@profilebot",
        "@human",
        "@profileapp",
        "USLACKBOT",
      ],
    });

    expect(result.results.map((item) => item.status)).toEqual([
      "not_found",
      "not_found",
      "not_found",
      "not_found",
      "not_found",
      "resolved",
      "resolved",
      "not_found",
    ]);
    expect(result.safe_to_mention).toBe(false);
    expect(JSON.stringify(result)).not.toContain("<@");
  });

  test("does not trust a syntactically valid user ID absent from the directory", async () => {
    const { client } = createClient([{ members: [] }]);

    const result = await resolveStrictUserIdentities({
      client,
      identities: ["U99999999"],
    });

    expect(result.directory.status).toBe("complete");
    expect(result.results).toEqual([
      {
        source: "U99999999",
        status: "not_found",
        candidate_count: 0,
      },
    ]);
    expect(result.safe_to_mention).toBe(false);
  });
});
