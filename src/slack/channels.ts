import type { SlackApiClient } from "./client.ts";
import { asArray, getString, isRecord } from "../lib/object-type-guards.ts";

const DEFAULT_CONVERSATION_TYPES = "public_channel,private_channel,im,mpim";

export type ConversationsPage = {
  channels: Record<string, unknown>[];
  next_cursor?: string;
};

export function isChannelId(input: string): boolean {
  return /^[CDG][A-Z0-9]{8,}$/.test(input);
}

/**
 * Open (or reuse) a DM channel with a user via conversations.open.
 * Returns the DM channel ID.
 */
export async function openDmChannel(client: SlackApiClient, userId: string): Promise<string> {
  const resp = await client.api("conversations.open", { users: userId });
  const channel = isRecord(resp) ? resp.channel : null;
  const channelId = isRecord(channel) ? getString(channel.id) : undefined;
  if (!channelId) {
    throw new Error(`Could not open DM channel for user: ${userId}`);
  }
  return channelId;
}

export function normalizeChannelInput(input: string): {
  kind: "id" | "name";
  value: string;
} {
  const trimmed = input.trim();
  if (trimmed.startsWith("#")) {
    return { kind: "name", value: trimmed.slice(1) };
  }
  if (isChannelId(trimmed)) {
    return { kind: "id", value: trimmed };
  }
  return { kind: "name", value: trimmed };
}

export async function resolveChannelId(client: SlackApiClient, input: string): Promise<string> {
  const normalized = normalizeChannelInput(input);
  if (normalized.kind === "id") {
    return normalized.value;
  }

  const name = normalized.value;
  if (!name) {
    throw new Error("Channel name is empty");
  }

  // Slack has no name→ID lookup API. conversations.list paginates the entire
  // workspace (200 at a time), which is O(channels) API calls — 3+ minutes in
  // large workspaces. search.messages with `in:#name` resolves it in one call
  // by returning a message whose metadata includes the channel ID.
  try {
    const searchResp = await client.api("search.messages", {
      query: `in:#${name}`,
      count: 1,
      sort: "timestamp",
      sort_dir: "desc",
    });
    const messages = isRecord(searchResp) ? searchResp.messages : null;
    const matches = isRecord(messages) ? asArray(messages.matches).filter(isRecord) : [];
    if (matches.length > 0) {
      const channel = isRecord(matches[0]!.channel) ? matches[0]!.channel : null;
      const channelId = channel ? getString(channel.id) : undefined;
      if (channelId) {
        return channelId;
      }
    }
  } catch {
    // search may fail (e.g. token lacks search:read scope) — fall through to pagination
  }

  // Fallback: paginate conversations.list until we find a match
  let cursor: string | undefined;
  for (;;) {
    const resp = await client.api("conversations.list", {
      exclude_archived: true,
      limit: 200,
      cursor,
      types: "public_channel,private_channel",
    });
    const chans = asArray(resp.channels).filter(isRecord);
    for (const c of chans) {
      if (getString(c.name) === name && getString(c.id)) {
        return getString(c.id)!;
      }
    }

    const meta = isRecord(resp.response_metadata) ? resp.response_metadata : null;
    const next = meta ? getString(meta.next_cursor) : undefined;
    if (!next) {
      break;
    }
    cursor = next;
  }

  throw new Error(`Could not resolve channel name: #${name}`);
}

/**
 * Resolve a channel/DM ID to a human-readable name via conversations.info.
 * Returns the channel name (e.g. "general") or DM user's display name,
 * falling back to the raw ID on failure.
 */
export async function resolveChannelName(
  client: SlackApiClient,
  channelId: string,
): Promise<string> {
  try {
    const resp = await client.api("conversations.info", { channel: channelId });
    const channel = isRecord(resp) ? resp.channel : null;
    if (!isRecord(channel)) {
      return channelId;
    }

    // DM: resolve the other user's name
    if (channel.is_im) {
      const userId = getString(channel.user);
      if (userId) {
        try {
          const userResp = await client.api("users.info", { user: userId });
          const user = isRecord(userResp) ? userResp.user : null;
          const profile = isRecord(user) ? user.profile : null;
          if (isRecord(profile)) {
            return getString(profile.display_name) || getString(profile.real_name) || channelId;
          }
        } catch {
          // fall through
        }
      }
      return channelId;
    }

    return getString(channel.name) || channelId;
  } catch {
    return channelId;
  }
}

type ListConversationsOptions = {
  limit?: number;
  cursor?: string;
  types?: string;
  excludeArchived?: boolean;
};

export async function listUserConversations(
  client: SlackApiClient,
  options?: ListConversationsOptions & { user?: string },
): Promise<ConversationsPage> {
  const resp = await client.api("users.conversations", {
    user: options?.user,
    limit: normalizeConversationsLimit(options?.limit),
    cursor: options?.cursor,
    types: options?.types ?? DEFAULT_CONVERSATION_TYPES,
    exclude_archived: options?.excludeArchived ?? true,
  });
  return normalizeConversationsPage(resp);
}

export async function listAllConversations(
  client: SlackApiClient,
  options?: ListConversationsOptions,
): Promise<ConversationsPage> {
  const resp = await client.api("conversations.list", {
    limit: normalizeConversationsLimit(options?.limit),
    cursor: options?.cursor,
    types: options?.types ?? DEFAULT_CONVERSATION_TYPES,
    exclude_archived: options?.excludeArchived ?? true,
  });
  return normalizeConversationsPage(resp);
}

/**
 * Enumerate the current user's joined conversations via `client.counts` +
 * `conversations.info`.
 *
 * This mirrors the slack web client's sidebar method and works on Enterprise
 * Grid, where `users.conversations` / `conversations.list` return
 * `enterprise_is_restricted` for browser/session tokens. `client.counts`
 * returns ids only (no names) split across `channels`, `mpims` and `ims`, so
 * each id is enriched with `conversations.info` to produce the same
 * channel-record shape as the other list helpers.
 *
 * Limitations vs `users.conversations`: there is no server-side pagination
 * (`client.counts` returns everything at once and is sliced to `limit`
 * locally), `--cursor` is not supported, and only the current user's
 * conversations are available (`--user` is not supported).
 */
export async function listConversationsViaCounts(
  client: SlackApiClient,
  options?: { limit?: number },
): Promise<ConversationsPage> {
  const limit = normalizeConversationsLimit(options?.limit);

  const resp = await client.api("client.counts", {
    thread_count_by_channel: true,
  });

  const entries = [
    ...asArray(resp.channels).filter(isRecord),
    ...asArray(resp.mpims).filter(isRecord),
    ...asArray(resp.ims).filter(isRecord),
  ];

  const ids = entries
    .map((entry) => getString(entry.id))
    .filter((id): id is string => Boolean(id))
    .slice(0, limit);

  const channels = await Promise.all(
    ids.map(async (id) => {
      try {
        const info = await client.api("conversations.info", { channel: id });
        return isRecord(info.channel) ? info.channel : { id };
      } catch {
        // counts may reference a conversation we can't open/info; keep the id
        return { id };
      }
    }),
  );

  return { channels, next_cursor: undefined };
}

export function normalizeConversationsPage(resp: Record<string, unknown>): ConversationsPage {
  const channels = asArray(resp.channels).filter(isRecord);
  const meta = isRecord(resp.response_metadata) ? resp.response_metadata : null;
  const next = meta ? getString(meta.next_cursor) : undefined;
  return { channels, next_cursor: next };
}

function normalizeConversationsLimit(value: number | undefined): number {
  return Math.min(Math.max(value ?? 100, 1), 1000);
}

export async function markConversation(
  client: SlackApiClient,
  options: { channelId: string; ts: string },
): Promise<void> {
  const { channelId, ts } = options;
  await client.api("conversations.mark", { channel: channelId, ts });
}
