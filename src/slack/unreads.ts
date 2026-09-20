import type { SlackApiClient } from "./client.ts";
import { asArray, getNumber, getString, isRecord } from "../lib/object-type-guards.ts";
import { isTeamRestrictedError } from "./api-errors.ts";
import { renderSlackMessageContent } from "./render.ts";

export type UnreadChannel = {
  channel_id: string;
  channel_name?: string;
  channel_type: "channel" | "dm" | "mpim" | "group";
  unread_count: number;
  mention_count: number;
  messages?: UnreadMessage[];
};

export type UnreadMessage = {
  ts: string;
  author?: { user_id?: string; bot_id?: string };
  content?: string;
  thread_ts?: string;
  reply_count?: number;
};

type ClientCountsEntry = {
  id: string;
  has_unreads?: boolean;
  unread_count?: number;
  unread_count_display?: number;
  mention_count?: number;
  latest?: string;
  last_read?: string;
};

type FetchUnreadsOptions = {
  includeMessages?: boolean;
  maxMessagesPerChannel?: number;
  maxBodyChars?: number;
  skipSystemMessages?: boolean;
};

type HydratedUnreads = {
  channels: UnreadChannel[];
  threads: {
    has_unreads: boolean;
    mention_count: number;
  } | null;
};

/**
 * Max recently-active DMs/MPIMs requested from `client.dms` on the
 * `team_is_restricted` fallback. Call volume is 1 `client.dms` plus at most
 * this many `conversations.info` calls (and history only for unread DMs when
 * message bodies are requested). It does not scan the full IM list.
 */
export const UNREADS_FALLBACK_DM_COUNT = 50;

/**
 * Max joined channels inspected on the fallback path. `users.conversations`
 * is sliced (and sorted by `updated` when present) so we do not pair
 * `conversations.info` + `conversations.history --limit 1` across the whole
 * joined set.
 */
export const UNREADS_FALLBACK_CHANNEL_LIMIT = 50;

const SYSTEM_SUBTYPES = [
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
  "group_join",
  "group_leave",
  "group_topic",
  "group_purpose",
  "group_name",
  "group_archive",
  "group_unarchive",
];

export async function fetchUnreads(
  client: SlackApiClient,
  options?: FetchUnreadsOptions,
): Promise<HydratedUnreads> {
  const resolved = resolveOptions(options);

  try {
    const resp = await client.api("client.counts", {
      thread_count_by_channel: true,
    });
    return hydrateFromCounts(client, resp, resolved);
  } catch (err) {
    if (!isTeamRestrictedError(err)) {
      throw err;
    }
    return fetchUnreadsFallback(client, resolved);
  }
}

function resolveOptions(options?: FetchUnreadsOptions): Required<FetchUnreadsOptions> {
  return {
    includeMessages: options?.includeMessages ?? true,
    maxMessagesPerChannel: options?.maxMessagesPerChannel ?? 10,
    maxBodyChars: options?.maxBodyChars ?? 4000,
    skipSystemMessages: options?.skipSystemMessages ?? true,
  };
}

async function hydrateFromCounts(
  client: SlackApiClient,
  resp: Record<string, unknown>,
  options: Required<FetchUnreadsOptions>,
): Promise<HydratedUnreads> {
  const channels = asArray(resp.channels).filter(isRecord) as unknown as ClientCountsEntry[];
  const mpims = asArray(resp.mpims).filter(isRecord) as unknown as ClientCountsEntry[];
  const ims = asArray(resp.ims).filter(isRecord) as unknown as ClientCountsEntry[];

  const allEntries = [
    ...channels.map((c) => ({ ...c, type: "channel" as const })),
    ...mpims.map((c) => ({ ...c, type: "mpim" as const })),
    ...ims.map((c) => ({ ...c, type: "dm" as const })),
  ];

  const withUnreads = allEntries.filter((c) => c.has_unreads);
  const channelInfos = await Promise.all(
    withUnreads.map((entry) => hydrateCountsEntry(client, entry, options)),
  );

  sortUnreadChannels(channelInfos);

  const threads = isRecord(resp.threads) ? resp.threads : null;
  const threadInfo = threads?.has_unreads
    ? {
        has_unreads: true,
        mention_count: (threads.mention_count as number) ?? 0,
      }
    : null;

  return { channels: channelInfos, threads: threadInfo };
}

async function hydrateCountsEntry(
  client: SlackApiClient,
  entry: ClientCountsEntry & { type: UnreadChannel["channel_type"] },
  options: Required<FetchUnreadsOptions>,
): Promise<UnreadChannel> {
  const channelInfoPromise = resolveConversationMeta(client, entry.id, entry.type);

  const historyPromise = (async () => {
    let messages: UnreadMessage[] | undefined;
    let unreadCount =
      entry.unread_count_display ?? entry.unread_count ?? (entry.has_unreads ? 1 : 0);

    if (options.includeMessages && entry.last_read) {
      try {
        const history = await fetchHistorySince(client, entry.id, entry.last_read, options);
        if (entry.unread_count_display === undefined && entry.unread_count === undefined) {
          unreadCount = history.messages.length;
          if (history.hasMore) {
            unreadCount = Math.max(unreadCount, 2);
          }
        }
        ({ messages } = history);
      } catch {
        // ignore
      }
    }
    return { messages, unreadCount };
  })();

  const [channelData, historyData] = await Promise.all([channelInfoPromise, historyPromise]);

  return {
    channel_id: entry.id,
    channel_name: channelData.name,
    channel_type: channelData.type,
    unread_count: historyData.unreadCount,
    mention_count: entry.mention_count ?? 0,
    messages: historyData.messages,
  };
}

async function fetchUnreadsFallback(
  client: SlackApiClient,
  options: Required<FetchUnreadsOptions>,
): Promise<HydratedUnreads> {
  const [dms, channels] = await Promise.all([
    fetchDmUnreadsFallback(client, options),
    fetchChannelUnreadsFallback(client, options),
  ]);

  const combined = [...channels, ...dms];
  sortUnreadChannels(combined);
  return { channels: combined, threads: null };
}

async function fetchDmUnreadsFallback(
  client: SlackApiClient,
  options: Required<FetchUnreadsOptions>,
): Promise<UnreadChannel[]> {
  const resp = await client.api("client.dms", {
    count: UNREADS_FALLBACK_DM_COUNT,
  });

  const entries = [
    ...asArray(resp.ims)
      .filter(isRecord)
      .map((entry) => ({ entry, type: "dm" as const })),
    ...asArray(resp.mpims)
      .filter(isRecord)
      .map((entry) => ({ entry, type: "mpim" as const })),
  ].slice(0, UNREADS_FALLBACK_DM_COUNT);

  const hydrated: (UnreadChannel | null)[] = await Promise.all(
    entries.map(async ({ entry, type }) => {
      const id = getString(entry.id);
      if (!id) {
        return null;
      }
      const latestMessage = isRecord(entry.message) ? entry.message : null;
      const latestTs = latestMessage ? getString(latestMessage.ts) : undefined;
      const info = await safeConversationsInfo(client, id);
      const lastRead = info ? getString(info.last_read) : undefined;
      if (!isTsNewer(latestTs, lastRead)) {
        return null;
      }

      const meta = await resolveConversationMeta(client, id, type, info);
      let messages: UnreadMessage[] | undefined;
      let unreadCount = 1;

      if (options.includeMessages) {
        if (lastRead) {
          try {
            const history = await fetchHistorySince(client, id, lastRead, options);
            unreadCount = Math.max(history.messages.length, 1);
            if (history.hasMore) {
              unreadCount = Math.max(unreadCount, 2);
            }
            ({ messages } = history);
          } catch {
            messages = latestMessage
              ? [toUnreadMessage(latestMessage, options.maxBodyChars)]
              : undefined;
          }
        } else if (latestMessage) {
          messages = [toUnreadMessage(latestMessage, options.maxBodyChars)];
        }
      }

      return {
        channel_id: id,
        ...(meta.name ? { channel_name: meta.name } : {}),
        channel_type: meta.type,
        unread_count: unreadCount,
        mention_count: 0,
        messages,
      };
    }),
  );

  return compactUnreadChannels(hydrated);
}

async function fetchChannelUnreadsFallback(
  client: SlackApiClient,
  options: Required<FetchUnreadsOptions>,
): Promise<UnreadChannel[]> {
  const resp = await client.api("users.conversations", {
    types: "public_channel,private_channel",
    exclude_archived: true,
    limit: UNREADS_FALLBACK_CHANNEL_LIMIT,
  });

  const listed = asArray(resp.channels)
    .filter(isRecord)
    .filter((ch) => getString(ch.id))
    .sort((a, b) => (getNumber(b.updated) ?? 0) - (getNumber(a.updated) ?? 0))
    .slice(0, UNREADS_FALLBACK_CHANNEL_LIMIT);

  const hydrated: (UnreadChannel | null)[] = await Promise.all(
    listed.map(async (listedChannel) => {
      const id = getString(listedChannel.id);
      if (!id) {
        return null;
      }
      const info = (await safeConversationsInfo(client, id)) ?? listedChannel;
      const lastRead = getString(info.last_read);
      const latestFromInfo = latestTsFromChannel(info);

      let latestTs = latestFromInfo;
      let historyMessages: UnreadMessage[] | undefined;
      let historyHasMore = false;
      let probedSinceLastRead = false;

      if (options.includeMessages && lastRead) {
        try {
          const history = await fetchHistorySince(client, id, lastRead, options);
          probedSinceLastRead = true;
          historyMessages = history.messages;
          historyHasMore = history.hasMore;
          latestTs = history.messages.at(-1)?.ts ?? latestTs;
        } catch {
          // fall through to a single latest-message probe
        }
      }

      if (!probedSinceLastRead && !latestTs) {
        try {
          const latest = await client.api("conversations.history", {
            channel: id,
            limit: 1,
          });
          const msgs = asArray(latest.messages).filter(isRecord);
          latestTs = msgs[0] ? getString(msgs[0].ts) : undefined;
          if (options.includeMessages && msgs[0] && isTsNewer(latestTs, lastRead)) {
            historyMessages = [toUnreadMessage(msgs[0], options.maxBodyChars)];
          }
        } catch {
          return null;
        }
      }

      if (probedSinceLastRead && (!historyMessages || historyMessages.length === 0)) {
        return null;
      }

      if (!isTsNewer(latestTs, lastRead)) {
        return null;
      }

      const meta = await resolveConversationMeta(client, id, "channel", info);
      let unreadCount = 1;
      if (historyMessages) {
        unreadCount = Math.max(historyMessages.length, 1);
        if (historyHasMore) {
          unreadCount = Math.max(unreadCount, 2);
        }
      }

      return {
        channel_id: id,
        ...(meta.name ? { channel_name: meta.name } : {}),
        channel_type: meta.type,
        unread_count: unreadCount,
        mention_count: 0,
        messages: historyMessages,
      };
    }),
  );

  return compactUnreadChannels(hydrated);
}

async function fetchHistorySince(
  client: SlackApiClient,
  channelId: string,
  lastRead: string,
  options: Required<FetchUnreadsOptions>,
): Promise<{ messages: UnreadMessage[]; hasMore: boolean }> {
  const history = await client.api("conversations.history", {
    channel: channelId,
    oldest: lastRead,
    limit: options.maxMessagesPerChannel,
    inclusive: false,
  });
  let msgs = asArray(history.messages).filter(isRecord);
  if (options.skipSystemMessages) {
    msgs = msgs.filter((m) => {
      const subtype = getString(m.subtype);
      return !subtype || !SYSTEM_SUBTYPES.includes(subtype);
    });
  }
  const messages = msgs.map((m) => toUnreadMessage(m, options.maxBodyChars));
  messages.sort((a, b) => Number.parseFloat(a.ts) - Number.parseFloat(b.ts));
  return { messages, hasMore: history.has_more === true };
}

function toUnreadMessage(m: Record<string, unknown>, maxBodyChars: number): UnreadMessage {
  const rendered = renderSlackMessageContent(m);
  const content =
    maxBodyChars >= 0 && rendered.length > maxBodyChars
      ? `${rendered.slice(0, maxBodyChars)}\n...`
      : rendered;

  return {
    ts: getString(m.ts) ?? "",
    author:
      getString(m.user) || getString(m.bot_id)
        ? {
            user_id: getString(m.user) ?? undefined,
            bot_id: getString(m.bot_id) ?? undefined,
          }
        : undefined,
    content: content || undefined,
    thread_ts: getString(m.thread_ts) ?? undefined,
    reply_count: getNumber(m.reply_count) ?? undefined,
  };
}

async function resolveConversationMeta(
  client: SlackApiClient,
  channelId: string,
  fallbackType: UnreadChannel["channel_type"],
  existing?: Record<string, unknown> | null,
): Promise<{ name: string | undefined; type: UnreadChannel["channel_type"] }> {
  const ch = existing ?? (await safeConversationsInfo(client, channelId));
  if (!ch) {
    return { name: undefined, type: fallbackType };
  }

  let name = getString(ch.name) ?? getString(ch.name_normalized) ?? undefined;
  let type = fallbackType;
  if (ch.is_im) {
    type = "dm";
    const userId = getString(ch.user);
    if (userId && !name) {
      name = await resolveUserDisplayName(client, userId);
    }
  } else if (ch.is_mpim) {
    type = "mpim";
  } else if (ch.is_group || ch.is_private || ch.is_channel) {
    type = "channel";
  }
  return { name, type };
}

async function resolveUserDisplayName(
  client: SlackApiClient,
  userId: string,
): Promise<string | undefined> {
  try {
    const userInfo = await client.api("users.info", { user: userId });
    const u = isRecord(userInfo.user) ? userInfo.user : null;
    const profile = u && isRecord(u.profile) ? u.profile : null;
    return (
      getString(profile?.display_name) || getString(u?.real_name) || getString(u?.name) || undefined
    );
  } catch {
    return undefined;
  }
}

async function safeConversationsInfo(
  client: SlackApiClient,
  channelId: string,
): Promise<Record<string, unknown> | null> {
  try {
    const info = await client.api("conversations.info", { channel: channelId });
    return isRecord(info.channel) ? info.channel : null;
  } catch {
    return null;
  }
}

function latestTsFromChannel(ch: Record<string, unknown>): string | undefined {
  const { latest } = ch;
  if (typeof latest === "string") {
    return latest;
  }
  if (isRecord(latest)) {
    return getString(latest.ts);
  }
  return undefined;
}

export function isTsNewer(latestTs: string | undefined, lastRead: string | undefined): boolean {
  if (!latestTs) {
    return false;
  }
  const latestN = Number.parseFloat(latestTs);
  if (!Number.isFinite(latestN)) {
    return false;
  }
  if (!lastRead) {
    return true;
  }
  const lastN = Number.parseFloat(lastRead);
  if (!Number.isFinite(lastN) || lastN === 0) {
    return true;
  }
  return latestN > lastN;
}

function sortUnreadChannels(channels: UnreadChannel[]): void {
  channels.sort((a, b) => {
    if (a.mention_count !== b.mention_count) {
      return b.mention_count - a.mention_count;
    }
    return b.unread_count - a.unread_count;
  });
}

function compactUnreadChannels(entries: (UnreadChannel | null)[]): UnreadChannel[] {
  const out: UnreadChannel[] = [];
  for (const entry of entries) {
    if (entry) {
      out.push(entry);
    }
  }
  return out;
}
