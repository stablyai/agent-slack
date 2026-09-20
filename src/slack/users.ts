import type { SlackApiClient } from "./client.ts";
import { asArray, getString, isRecord } from "../lib/object-type-guards.ts";
import { indexUsersInCache, lookupCachedUserId } from "./user-cache.ts";
import { isUserId } from "./user-id.ts";
import { toCompactUser, type CompactSlackUser } from "./compact-user.ts";

export type { CompactSlackUser };
export { toCompactUser };

export async function listUsers(
  client: SlackApiClient,
  options?: {
    limit?: number;
    cursor?: string;
    includeBots?: boolean;
    refresh?: boolean;
  },
): Promise<{ users: CompactSlackUser[]; next_cursor?: string }> {
  const limit = Math.min(Math.max(options?.limit ?? 200, 1), 1000);
  const includeBots = options?.includeBots ?? false;
  const refresh = options?.refresh ?? false;
  const workspaceUrl = clientWorkspaceUrl(client);

  let next_cursor: string | undefined;
  const [out, dmMap] = await Promise.all([
    (async () => {
      const users: CompactSlackUser[] = [];
      let cursor = options?.cursor;
      for (;;) {
        const pageSize = refresh ? 200 : Math.min(200, Math.max(limit - users.length, 1));
        const resp = await client.api("users.list", { limit: pageSize, cursor });
        const members = asArray(resp.members).filter(isRecord);
        const pageUsers: CompactSlackUser[] = [];
        for (const m of members) {
          const id = getString(m.id);
          if (!id) {
            continue;
          }
          const compact = toCompactUser(m);
          pageUsers.push(compact);
          if (!includeBots && m.is_bot) {
            continue;
          }
          if (users.length < limit) {
            users.push(compact);
          }
        }
        await indexUsersInCache({ workspaceUrl, users: pageUsers });
        const meta = isRecord(resp.response_metadata) ? resp.response_metadata : null;
        const next = meta ? getString(meta.next_cursor) : undefined;
        if (!next) {
          next_cursor = undefined;
          break;
        }
        cursor = next;
        next_cursor = next;
        if (!refresh && users.length >= limit) {
          break;
        }
      }
      return users;
    })(),
    fetchDmMap(client),
  ]);

  for (const u of out) {
    const dmId = dmMap.get(u.id);
    if (dmId) {
      u.dm_id = dmId;
    }
  }

  return { users: out, next_cursor };
}

export async function getUser(
  client: SlackApiClient,
  input: string,
  options?: { forceRefresh?: boolean },
): Promise<CompactSlackUser> {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("User is empty");
  }

  const userId = await resolveUserId(client, trimmed, options);
  if (!userId) {
    throw new Error(`Could not resolve user: ${input}`);
  }

  const resp = await client.api("users.info", { user: userId });
  const u = isRecord(resp.user) ? resp.user : null;
  if (!u || !getString(u.id)) {
    throw new Error("users.info returned no user");
  }
  const compact = toCompactUser(u);
  await indexUsersInCache({
    workspaceUrl: clientWorkspaceUrl(client),
    users: [compact],
  });
  return compact;
}

export async function resolveUserId(
  client: SlackApiClient,
  input: string,
  options?: { forceRefresh?: boolean; workspaceUrl?: string },
): Promise<string | null> {
  const trimmed = input.trim();
  if (isUserId(trimmed)) {
    return trimmed;
  }

  const workspaceUrl = options?.workspaceUrl ?? clientWorkspaceUrl(client);
  const forceRefresh = options?.forceRefresh ?? false;
  const looksLikeEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed) && !trimmed.startsWith("@");
  const handle = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  if (!handle) {
    return null;
  }

  if (!forceRefresh) {
    const cached = await lookupCachedUserId({
      workspaceUrl,
      handle: looksLikeEmail ? undefined : handle,
      email: looksLikeEmail ? trimmed : undefined,
    });
    if (cached) {
      return cached;
    }
  }

  if (looksLikeEmail && !isBrowserAuth(client)) {
    try {
      const byEmail = await client.api("users.lookupByEmail", { email: trimmed });
      const user = isRecord(byEmail.user) ? byEmail.user : null;
      if (user) {
        const compact = toCompactUser(user);
        const userId = compact.id || getString(user.id);
        if (userId) {
          await indexUsersInCache({ workspaceUrl, users: [{ ...compact, id: userId }] });
          return userId;
        }
      }
    } catch {
      // Fallback to users.list scan below.
    }
  }

  const handleLower = handle.toLowerCase();
  const emailLower = trimmed.toLowerCase();
  let cursor: string | undefined;
  for (;;) {
    const resp = await client.api("users.list", { limit: 200, cursor });
    const members = asArray(resp.members).filter(isRecord);
    await indexUsersInCache({
      workspaceUrl,
      users: members.map((m) => toCompactUser(m)),
    });
    const found = members.find((m) => {
      if (getString(m.name)?.toLowerCase() === handleLower) {
        return true;
      }
      if (looksLikeEmail) {
        const profile = isRecord(m.profile) ? m.profile : null;
        const email = profile ? getString(profile.email) : undefined;
        return Boolean(email) && email?.toLowerCase() === emailLower;
      }
      return false;
    });
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

export async function warmUserResolutionCache(
  client: SlackApiClient,
): Promise<{ users_indexed: number; pages: number }> {
  const workspaceUrl = clientWorkspaceUrl(client);
  let cursor: string | undefined;
  let pages = 0;
  let usersIndexed = 0;
  for (;;) {
    const resp = await client.api("users.list", { limit: 200, cursor });
    pages += 1;
    const members = asArray(resp.members).filter(isRecord);
    const users = members.map((m) => toCompactUser(m));
    usersIndexed += users.filter((u) => isUserId(u.id)).length;
    await indexUsersInCache({ workspaceUrl, users });
    const meta = isRecord(resp.response_metadata) ? resp.response_metadata : null;
    const next = meta ? getString(meta.next_cursor) : undefined;
    if (!next) {
      break;
    }
    cursor = next;
  }
  return { users_indexed: usersIndexed, pages };
}

function clientWorkspaceUrl(client: SlackApiClient): string | undefined {
  if (typeof client.getWorkspaceUrl === "function") {
    return client.getWorkspaceUrl();
  }
  return undefined;
}

function isBrowserAuth(client: SlackApiClient): boolean {
  if (typeof client.getAuthType === "function") {
    return client.getAuthType() === "browser";
  }
  return false;
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
      if (id && user) {
        map.set(user, id);
      }
    }
    const meta = isRecord(resp.response_metadata) ? resp.response_metadata : null;
    const next = meta ? getString(meta.next_cursor) : undefined;
    if (!next) {
      break;
    }
    cursor = next;
  }
  return map;
}

export async function getDmChannelForUsers(
  client: SlackApiClient,
  inputs: string[],
): Promise<{ user_ids: string[]; dm_channel_id: string; channel_type: "dm" | "group_dm" }> {
  if (!inputs || inputs.length === 0) {
    throw new Error("At least one user is required");
  }

  if (inputs.length > 8) {
    throw new Error("Slack supports a maximum of 8 users in a group DM");
  }

  const userIds: string[] = [];
  for (const input of inputs) {
    const trimmed = input.trim();
    if (!trimmed) {
      continue;
    }
    const userId = await resolveUserId(client, trimmed);
    if (!userId) {
      throw new Error(`Could not resolve user: ${input}`);
    }
    userIds.push(userId);
  }

  if (userIds.length === 0) {
    throw new Error("No valid users provided");
  }

  const resp = await client.api("conversations.open", { users: userIds.join(",") });
  const channel = isRecord(resp.channel) ? resp.channel : null;
  const channelId = channel ? getString(channel.id) : null;

  if (!channelId) {
    throw new Error("conversations.open returned no channel");
  }

  const channelType = channelId.startsWith("D") ? "dm" : "group_dm";

  return {
    user_ids: userIds,
    dm_channel_id: channelId,
    channel_type: channelType,
  };
}
