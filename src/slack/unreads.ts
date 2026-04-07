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
  unread_count?: number;
  unread_count_display?: number;
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
      // 1. Concurrently fetch channel info & user info (if DM)
      const channelInfoPromise = (async () => {
        let name: string | undefined;
        let { type } = entry;
        try {
          const info = await client.api("conversations.info", {
            channel: entry.id,
          });
          const ch = isRecord(info.channel) ? info.channel : null;
          if (ch) {
            name = getString(ch.name) ?? getString(ch.name_normalized) ?? undefined;
            if (ch.is_im) {
              type = "dm";
              const userId = getString(ch.user);
              if (userId && !name) {
                try {
                  const userInfo = await client.api("users.info", { user: userId });
                  const u = isRecord(userInfo.user) ? userInfo.user : null;
                  const profile = u && isRecord(u.profile) ? u.profile : null;
                  name =
                    getString(profile?.display_name) ||
                    getString(u?.real_name) ||
                    getString(u?.name) ||
                    undefined;
                } catch {
                  // ignore
                }
              }
            } else if (ch.is_mpim) {
              type = "mpim";
            } else if (ch.is_group || ch.is_private) {
              type = "group";
            } else {
              type = "channel";
            }
          }
        } catch {
          // ignore - name will remain undefined
        }
        return { name, type };
      })();

      // 2. Concurrently fetch message history
      const historyPromise = (async () => {
        let messages: UnreadMessage[] | undefined;
        let unreadCount =
          entry.unread_count_display ?? entry.unread_count ?? (entry.has_unreads ? 1 : 0);

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
              msgs = msgs.filter((m) => {
                const subtype = getString(m.subtype);
                if (!subtype) {
                  return true;
                }
                const systemSubtypes = [
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
                return !systemSubtypes.includes(subtype);
              });
            }

            // If API didn't provide a count, infer from messages fetched
            if (entry.unread_count_display === undefined && entry.unread_count === undefined) {
              unreadCount = msgs.length;
              if (history.has_more) {
                unreadCount = Math.max(unreadCount, 2);
              }
            }

            messages = msgs.map((m) => {
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
            });

            // Sort chronologically (oldest first)
            messages.sort((a, b) => Number.parseFloat(a.ts) - Number.parseFloat(b.ts));
          } catch {
            // ignore
          }
        }
        return { messages, unreadCount };
      })();

      // 3. Await both sets of network requests at the same time
      const [channelData, historyData] = await Promise.all([channelInfoPromise, historyPromise]);

      return {
        channel_id: entry.id,
        channel_name: channelData.name,
        channel_type: channelData.type,
        unread_count: historyData.unreadCount,
        mention_count: entry.mention_count ?? 0,
        messages: historyData.messages,
      } satisfies UnreadChannel;
    }),
  );

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
