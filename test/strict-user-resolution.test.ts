import { describe, expect, test } from "bun:test";
import type { SlackApiClient } from "../src/slack/client.ts";
import {
  MAX_USER_RESOLUTION_IDENTITIES,
  resolveStrictUserIdentities,
} from "../src/slack/strict-user-resolution.ts";

type ApiCall = { method: string; params: Record<string, unknown> };

function user(id: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  const profile =
    fields.profile && typeof fields.profile === "object" && !Array.isArray(fields.profile)
      ? fields.profile
      : {};
  return {
    id,
    deleted: false,
    is_bot: false,
    ...fields,
    profile: { ...profile },
  };
}

function client(
  handler: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>,
): SlackApiClient {
  return {
    api: handler,
    lookupUserByEmail: (email: string) => handler("users.lookupByEmail", { email }),
  } as unknown as SlackApiClient;
}

describe("strict batch user resolution", () => {
  test("uses direct ID and email lookups and preserves input order", async () => {
    const calls: ApiCall[] = [];
    const result = await resolveStrictUserIdentities({
      client: client(async (method, params) => {
        calls.push({ method, params });
        if (method === "users.info") {
          return { user: user(String(params.user)) };
        }
        if (method === "users.lookupByEmail") {
          return { user: user("U33333333") };
        }
        throw new Error(`Unexpected method: ${method}`);
      }),
      identities: ["U11111111", "W22222222", "Alice@Example.com"],
    });

    expect(calls).toEqual([
      { method: "users.info", params: { user: "U11111111" } },
      { method: "users.info", params: { user: "W22222222" } },
      { method: "users.lookupByEmail", params: { email: "alice@example.com" } },
    ]);
    expect(result).toEqual({
      safe_to_mention: true,
      results: [
        { index: 0, status: "resolved", mention: "<@U11111111>" },
        { index: 1, status: "resolved", mention: "<@W22222222>" },
        { index: 2, status: "resolved", mention: "<@U33333333>" },
      ],
    });
  });

  test("deduplicates canonical identities while preserving repeated results", async () => {
    const calls: ApiCall[] = [];
    const result = await resolveStrictUserIdentities({
      client: client(async (method, params) => {
        calls.push({ method, params });
        return { user: user("U33333333") };
      }),
      identities: ["Alice@Example.com", "alice@example.com", "U33333333", "U33333333"],
    });

    expect(calls).toEqual([
      { method: "users.lookupByEmail", params: { email: "alice@example.com" } },
      { method: "users.info", params: { user: "U33333333" } },
    ]);
    expect(result).toEqual({
      safe_to_mention: true,
      results: [
        { index: 0, status: "resolved", mention: "<@U33333333>" },
        { index: 1, status: "resolved", mention: "<@U33333333>" },
        { index: 2, status: "resolved", mention: "<@U33333333>" },
        { index: 3, status: "resolved", mention: "<@U33333333>" },
      ],
    });
  });

  test("verifies an exact browser-search email candidate with users.info", async () => {
    const calls: ApiCall[] = [];
    const apiClient = {
      lookupUserByEmail: async (email: string, edgeCacheId?: string) => {
        calls.push({ method: "users/search", params: { email, edgeCacheId } });
        return {
          ok: true,
          results: [
            user("U33333333", { profile: { email: "alice@example.com" } }),
            user("U44444444", { profile: { email: "someone@example.com" } }),
          ],
        };
      },
      api: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        return { user: user(String(params.user)) };
      },
    } as unknown as SlackApiClient;

    const result = await resolveStrictUserIdentities({
      client: apiClient,
      identities: ["Alice@Example.com"],
      edgeCacheId: "E12345678",
    });

    expect(calls).toEqual([
      {
        method: "users/search",
        params: { email: "alice@example.com", edgeCacheId: "E12345678" },
      },
      { method: "users.info", params: { user: "U33333333" } },
    ]);
    expect(result).toEqual({
      safe_to_mention: true,
      results: [{ index: 0, status: "resolved", mention: "<@U33333333>" }],
    });
  });

  test("withholds every mention when one direct lookup is not found", async () => {
    const result = await resolveStrictUserIdentities({
      client: client(async (method, params) => {
        if (method === "users.info") {
          return { user: user(String(params.user)) };
        }
        throw new Error("users_not_found");
      }),
      identities: ["U11111111", "missing@example.com"],
    });

    expect(result).toEqual({
      safe_to_mention: false,
      results: [
        { index: 0, status: "resolved" },
        { index: 1, status: "unresolved" },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("<@");
  });

  test("recognizes standard-token not-found errors", async () => {
    const error = Object.assign(new Error("An API error occurred: user_not_found"), {
      data: { error: "user_not_found" },
    });
    const result = await resolveStrictUserIdentities({
      client: client(async () => {
        throw error;
      }),
      identities: ["U11111111"],
    });

    expect(result).toEqual({
      safe_to_mention: false,
      results: [{ index: 0, status: "unresolved" }],
    });
  });

  test("rejects inactive users and bot signals", async () => {
    const unsafeUsers = [
      user("U40000001", { deleted: true }),
      user("U40000002", { is_bot: true }),
      user("USLACKBOT"),
      user("U40000003", { profile: { bot_id: "B12345678" } }),
      user("U40000004", { is_connector_bot: true }),
      user("U40000005", { is_workflow_bot: true }),
      user("U40000006", { is_agentforce_bot: true }),
      user("U40000007", { is_invited_user: true }),
      user("U40000008", { suspended: true }),
      user("U40000009", { is_forgotten: true }),
      user("U40000010", { profile: { is_agentforce_bot: true } }),
      user("U40000011", { profile: { is_sidekick_bot: true } }),
      user("U40000012", { suspended: "false" }),
      user("U40000013", { is_profile_only_user: true }),
    ];
    let index = 0;
    const result = await resolveStrictUserIdentities({
      client: client(async () => ({ user: unsafeUsers[index++] })),
      identities: unsafeUsers.map((item) => String(item.id)),
    });

    expect(result.safe_to_mention).toBe(false);
    expect(result.results.every((item) => item.status === "unresolved")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("<@");
  });

  test("fails closed on malformed or mismatched users", async () => {
    const cases: { identity: string; response: Record<string, unknown> }[] = [
      { identity: "U11111111", response: {} },
      { identity: "U11111111", response: { user: [] } },
      { identity: "U11111111", response: { user: user("U22222222") } },
      {
        identity: "U11111111",
        response: { user: { id: "U11111111", deleted: false, is_bot: false } },
      },
      { identity: "alice@example.com", response: { user: user("not-a-user-id") } },
    ];

    for (const { identity, response } of cases) {
      await expect(
        resolveStrictUserIdentities({
          client: client(async () => response),
          identities: [identity],
        }),
      ).resolves.toEqual({
        safe_to_mention: false,
        results: [{ index: 0, status: "unresolved" }],
      });
    }
  });

  test("rejects unsupported identities before any API call", async () => {
    let calls = 0;
    const apiClient = client(async () => {
      calls += 1;
      return {};
    });
    for (const identity of ["@alice", "Alice Smith", "alice", "u12345678", "<@U12345678>"]) {
      await expect(
        resolveStrictUserIdentities({ client: apiClient, identities: [identity] }),
      ).rejects.toThrow("canonical U/W ID or email");
    }
    expect(calls).toBe(0);
  });

  test("rejects an oversized batch before any API call", async () => {
    let calls = 0;
    const apiClient = client(async () => {
      calls += 1;
      return {};
    });
    const identities = Array.from(
      { length: MAX_USER_RESOLUTION_IDENTITIES + 1 },
      (_, index) => `person-${index}@example.com`,
    );

    await expect(resolveStrictUserIdentities({ client: apiClient, identities })).rejects.toThrow(
      `At most ${MAX_USER_RESOLUTION_IDENTITIES}`,
    );
    expect(calls).toBe(0);
  });

  test("propagates non-definitive request errors", async () => {
    await expect(
      resolveStrictUserIdentities({
        client: client(async () => {
          throw new Error("rate_limited");
        }),
        identities: ["U11111111"],
      }),
    ).rejects.toThrow("rate_limited");
  });
});
