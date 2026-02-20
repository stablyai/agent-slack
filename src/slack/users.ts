import type { SlackApiClient } from "./client.ts";
import { asArray, getString, isRecord } from "../lib/object-type-guards.ts";

export type CompactSlackUser = {
  id: string;
  name?: string; // handle
  real_name?: string;
  display_name?: string;
  email?: string;
  title?: string;
  tz?: string;
  is_bot?: boolean;
  deleted?: boolean;
  dm_id?: string;
};

export async function listUsers(
  client: SlackApiClient,
  options?: {
    limit?: number;
    cursor?: string;
    includeBots?: boolean;
  },
): Promise<{ users: CompactSlackUser[]; next_cursor?: string }> {
  const limit = Math.min(Math.max(options?.limit ?? 200, 1), 1000);
  const includeBots = options?.includeBots ?? false;

  let next_cursor: string | undefined;
  const [out, dmMap] = await Promise.all([
    (async () => {
      const users: CompactSlackUser[] = [];
      let cursor = options?.cursor;
      while (users.length < limit) {
        const pageSize = Math.min(200, limit - users.length);
        const resp = await client.api("users.list", { limit: pageSize, cursor });
        const members = asArray(resp.members).filter(isRecord);
        for (const m of members) {
          const id = getString(m.id);
          if (!id) continue;
          if (!includeBots && m.is_bot) continue;
          users.push(toCompactUser(m));
          if (users.length >= limit) break;
        }
        const meta = isRecord(resp.response_metadata) ? resp.response_metadata : null;
        const next = meta ? getString(meta.next_cursor) : undefined;
        if (!next) break;
        cursor = next;
        next_cursor = next;
      }
      return users;
    })(),
    fetchDmMap(client),
  ]);

  for (const u of out) {
    const dmId = dmMap.get(u.id);
    if (dmId) u.dm_id = dmId;
  }

  return { users: out, next_cursor };
}

export async function getUser(client: SlackApiClient, input: string): Promise<CompactSlackUser> {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("User is empty");
  }

  const userId = await resolveUserId(client, trimmed);
  if (!userId) {
    throw new Error(`Could not resolve user: ${input}`);
  }

  const resp = await client.api("users.info", { user: userId });
  const u = isRecord(resp.user) ? resp.user : null;
  if (!u || !getString(u.id)) {
    throw new Error("users.info returned no user");
  }
  return toCompactUser(u);
}

async function resolveUserId(client: SlackApiClient, input: string): Promise<string | null> {
  const trimmed = input.trim();
  if (/^U[A-Z0-9]{8,}$/.test(trimmed)) {
    return trimmed;
  }

  const handle = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  if (!handle) {
    return null;
  }

  let cursor: string | undefined;
  for (;;) {
    const resp = await client.api("users.list", { limit: 200, cursor });
    const members = asArray(resp.members).filter(isRecord);
    const found = members.find((m) => getString(m.name) === handle);
    if (found) {
      const id = getString(found.id);
      if (id) {
        return id;
      }
    }
    const meta = isRecord(resp.response_metadata) ? resp.response_metadata : null;
    const next = meta ? getString(meta.next_cursor) : undefined;
    if (!next) {
      break;
    }
    cursor = next;
  }
  return null;
}

async function fetchDmMap(client: SlackApiClient): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let cursor: string | undefined;
  for (;;) {
    const resp = await client.api("conversations.list", {
      types: "im",
      limit: 200,
      cursor,
    });
    const channels = asArray(resp.channels).filter(isRecord);
    for (const ch of channels) {
      const id = getString(ch.id);
      const user = getString(ch.user);
      if (id && user) map.set(user, id);
    }
    const meta = isRecord(resp.response_metadata) ? resp.response_metadata : null;
    const next = meta ? getString(meta.next_cursor) : undefined;
    if (!next) break;
    cursor = next;
  }
  return map;
}

function toCompactUser(u: Record<string, unknown>): CompactSlackUser {
  const profile = isRecord(u.profile) ? u.profile : {};
  return {
    id: getString(u.id) ?? "",
    name: getString(u.name) ?? undefined,
    real_name: getString(u.real_name) ?? undefined,
    display_name: getString(profile.display_name) ?? undefined,
    email: getString(profile.email) ?? undefined,
    title: getString(profile.title) ?? undefined,
    tz: getString(u.tz) ?? undefined,
    is_bot: typeof u.is_bot === "boolean" ? u.is_bot : undefined,
    deleted: typeof u.deleted === "boolean" ? u.deleted : undefined,
  };
}
