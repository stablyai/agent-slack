import type { SlackApiClient } from "./client.ts";
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
  mention_count?: number;
  latest?: string;
  last_read?: string;
};

export async function fetchUnreads(
  client: SlackApiClient,
  options?: {
    includeMessages?: boolean;
    maxMessagesPerChannel?: number;
    maxBodyChars?: number;
    skipSystemMessages?: boolean;
  },
): Promise<{
  channels: UnreadChannel[];
  threads: {
    has_unreads: boolean;
    mention_count: number;
  } | null;
}> {
  const includeMessages = options?.includeMessages ?? true;
  const maxMessages = options?.maxMessagesPerChannel ?? 10;
  const maxBodyChars = options?.maxBodyChars ?? 4000;
  const skipSystem = options?.skipSystemMessages ?? true;

  const resp = await client.api("client.counts", {
    thread_count_by_channel: true,
  });

  const channels = asArray(resp.channels).filter(isRecord) as unknown as ClientCountsEntry[];
  const mpims = asArray(resp.mpims).filter(isRecord) as unknown as ClientCountsEntry[];
  const ims = asArray(resp.ims).filter(isRecord) as unknown as ClientCountsEntry[];

  const allEntries = [
    ...channels.map((c) => ({ ...c, type: "channel" as const })),
    ...mpims.map((c) => ({ ...c, type: "mpim" as const })),
    ...ims.map((c) => ({ ...c, type: "dm" as const })),
  ];

  const withUnreads = allEntries.filter((c) => c.has_unreads);

  // Resolve channel info and fetch messages in parallel
  const channelInfos = await Promise.all(
    withUnreads.map(async (entry) => {
      let channelName: string | undefined;
      let channelType: "channel" | "dm" | "mpim" | "group" = entry.type;
      let unreadCount = 0;

      try {
        const info = await client.api("conversations.info", {
          channel: entry.id,
        });
        const ch = isRecord(info.channel) ? info.channel : null;
        if (ch) {
          channelName = getString(ch.name) ?? getString(ch.name_normalized) ?? undefined;
          if (ch.is_im) {
            channelType = "dm";
          } else if (ch.is_mpim) {
            channelType = "mpim";
          } else if (ch.is_group || ch.is_private) {
            channelType = "group";
          } else {
            channelType = "channel";
          }
        }
      } catch {
        // ignore - name will be undefined
      }

      let messages: UnreadMessage[] | undefined;

      if (includeMessages && entry.last_read) {
        try {
          const history = await client.api("conversations.history", {
            channel: entry.id,
            oldest: entry.last_read,
            limit: maxMessages,
            inclusive: false,
          });
          let msgs = asArray(history.messages).filter(isRecord);
          if (skipSystem) {
            msgs = msgs.filter((m) => !getString(m.subtype));
          }
          unreadCount = msgs.length;

          messages = msgs.map((m) => {
            const rendered = renderSlackMessageContent(m);
            const content =
              maxBodyChars >= 0 && rendered.length > maxBodyChars
                ? `${rendered.slice(0, maxBodyChars)}\n…`
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
          });

          // Sort chronologically (oldest first)
          messages.sort((a, b) => Number.parseFloat(a.ts) - Number.parseFloat(b.ts));
        } catch {
          // ignore - messages will be undefined
        }
      } else if (!includeMessages && entry.last_read) {
        // Just get count without messages
        try {
          const history = await client.api("conversations.history", {
            channel: entry.id,
            oldest: entry.last_read,
            limit: 1,
            inclusive: false,
          });
          let msgs = asArray(history.messages);
          if (skipSystem) {
            msgs = msgs.filter((m) => isRecord(m) && !getString(m.subtype));
          }
          unreadCount = msgs.length;
          if (history.has_more) {
            // We know there's more than 1, but can't get exact count cheaply
            unreadCount = Math.max(entry.mention_count ?? 1, 2);
          }
        } catch {
          unreadCount = entry.mention_count ?? 0;
        }
      }

      return {
        channel_id: entry.id,
        channel_name: channelName,
        channel_type: channelType,
        unread_count: unreadCount,
        mention_count: entry.mention_count ?? 0,
        messages,
      } satisfies UnreadChannel;
    }),
  );

  // For DMs, resolve user display names
  const dmChannels = channelInfos.filter((c) => c.channel_type === "dm" && !c.channel_name);
  if (dmChannels.length > 0) {
    await Promise.all(
      dmChannels.map(async (dm) => {
        try {
          const info = await client.api("conversations.info", {
            channel: dm.channel_id,
          });
          const ch = isRecord(info.channel) ? info.channel : null;
          const userId = ch ? getString(ch.user) : undefined;
          if (userId) {
            const userInfo = await client.api("users.info", {
              user: userId,
            });
            const u = isRecord(userInfo.user) ? userInfo.user : null;
            const profile = u && isRecord(u.profile) ? u.profile : null;
            dm.channel_name =
              getString(profile?.display_name) ||
              getString(u?.real_name) ||
              getString(u?.name) ||
              undefined;
          }
        } catch {
          // ignore
        }
      }),
    );
  }

  // Sort: mentions first, then by unread count
  channelInfos.sort((a, b) => {
    if (a.mention_count !== b.mention_count) {
      return b.mention_count - a.mention_count;
    }
    return b.unread_count - a.unread_count;
  });

  // Process thread unreads
  const threads = isRecord(resp.threads) ? resp.threads : null;
  const threadInfo = threads?.has_unreads
    ? {
        has_unreads: true,
        mention_count: (threads.mention_count as number) ?? 0,
      }
    : null;

  return { channels: channelInfos, threads: threadInfo };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
