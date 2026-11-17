import { describe, expect, test } from "bun:test";
import {
  createChannel,
  parseInviteUsersCsv,
  splitEmailsFromInviteTargets,
} from "../src/slack/channel-admin.ts";
import type { SlackApiClient } from "../src/slack/client.ts";

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

type ApiCall = { method: string; params: Record<string, unknown> };

function fakeClient(responses: Record<string, Record<string, unknown>>) {
  const calls: ApiCall[] = [];
  const client = {
    api: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      const resp = responses[method];
      if (!resp) {
        throw new Error(`unexpected ${method}`);
      }
      return resp;
    },
  } as unknown as SlackApiClient;
  return { client, calls };
}

const CREATED = { ok: true, channel: { id: "C1", name: "new-chan", is_private: true } };

describe("createChannel team_id", () => {
  test("workspace-level token sends no team_id", async () => {
    const { client, calls } = fakeClient({
      "auth.test": { ok: true, is_enterprise_install: false },
      "conversations.create": CREATED,
    });
    await createChannel(client, { name: "new-chan", isPrivate: true });
    const create = calls.find((c) => c.method === "conversations.create");
    expect(create?.params).toEqual({ name: "new-chan", is_private: true });
  });

  test("explicit teamId is sent and skips lookups", async () => {
    const { client, calls } = fakeClient({ "conversations.create": CREATED });
    await createChannel(client, { name: "new-chan", teamId: " T111 " });
    expect(calls.map((c) => c.method)).toEqual(["conversations.create"]);
    expect(calls[0]?.params.team_id).toBe("T111");
  });

  test("org-level token with one workspace resolves team_id automatically", async () => {
    const { client, calls } = fakeClient({
      "auth.test": { ok: true, is_enterprise_install: true, user_id: "U1" },
      "users.info": { ok: true, user: { enterprise_user: { teams: ["T111"] } } },
      "conversations.create": CREATED,
    });
    await createChannel(client, { name: "new-chan" });
    const create = calls.find((c) => c.method === "conversations.create");
    expect(create?.params.team_id).toBe("T111");
  });

  test("org-level token with several workspaces asks for --team and lists them", async () => {
    const { client, calls } = fakeClient({
      "auth.test": { ok: true, is_enterprise_install: true, user_id: "U1" },
      "users.info": { ok: true, user: { enterprise_user: { teams: ["T111", "T222"] } } },
      "team.info": { ok: true, team: { name: "Alpha" } },
      "conversations.create": CREATED,
    });
    await expect(createChannel(client, { name: "new-chan" })).rejects.toThrow(
      /--team .*T111 \(Alpha\), T222 \(Alpha\)/,
    );
    expect(calls.some((c) => c.method === "conversations.create")).toBe(false);
  });
});
