import type { SlackApiClient } from "./client.ts";
import { renderSlackMessageContent } from "./render.ts";

export type LaterItem = {
  channel_id: string;
  channel_name?: string;
  ts: string;
  state: string;
  date_saved: number;
  date_completed?: number;
  message?: {
    author?: { user_id?: string; bot_id?: string };
    content?: string;
    thread_ts?: string;
    reply_count?: number;
  };
};

export async function fetchLaterItems(
  client: SlackApiClient,
  options?: {
    state?: "in_progress" | "archived" | "completed" | "all";
    limit?: number;
    maxBodyChars?: number;
    countsOnly?: boolean;
    cursor?: string;
  },
): Promise<{
  counts: {
    in_progress: number;
    archived: number;
    completed: number;
    total: number;
  };
  items: LaterItem[];
  next_cursor?: string;
}> {
  const stateFilter = options?.state ?? "in_progress";
  const limit = options?.limit ?? 20;
  const maxBodyChars = options?.maxBodyChars ?? 4000;
  const countsOnly = options?.countsOnly ?? false;

  const resp = await client.api("saved.list", {
    limit: 50,
    cursor: options?.cursor,
  });

  const rawItems = asArray(resp.saved_items).filter(isRecord);
  const counts = isRecord(resp.counts) ? resp.counts : {};

  const result = {
    counts: {
      in_progress: getNumber(counts.uncompleted_count) ?? 0,
      archived: getNumber(counts.archived_count) ?? 0,
      completed: getNumber(counts.completed_count) ?? 0,
      total: getNumber(counts.total_count) ?? 0,
    },
    items: [] as LaterItem[],
    next_cursor: undefined as string | undefined,
  };

  if (countsOnly) {
    return result;
  }

  // Filter to messages only, then by state
  let filtered = rawItems.filter((item) => getString(item.item_type) === "message");
  if (stateFilter !== "all") {
    filtered = filtered.filter((item) => getString(item.state) === stateFilter);
  }

  // Limit results
  filtered = filtered.slice(0, limit);

  // Hydrate items in parallel
  result.items = await Promise.all(
    filtered.map(async (item) => {
      const channelId = getString(item.item_id) ?? "";
      const ts = getString(item.ts) ?? "";
      const state = getString(item.state) ?? "in_progress";
      const dateSaved = getNumber(item.date_created) ?? 0;
      const dateCompleted = getNumber(item.date_completed);

      let channelName: string | undefined;
      let message: LaterItem["message"];

      // Resolve channel name
      try {
        const info = await client.api("conversations.info", {
          channel: channelId,
        });
        const ch = isRecord(info.channel) ? info.channel : null;
        if (ch) {
          channelName = getString(ch.name) ?? getString(ch.name_normalized) ?? undefined;

          // For DMs, resolve user display name
          if (ch.is_im && !channelName) {
            const userId = getString(ch.user);
            if (userId) {
              try {
                const userInfo = await client.api("users.info", { user: userId });
                const u = isRecord(userInfo.user) ? userInfo.user : null;
                const profile = u && isRecord(u.profile) ? u.profile : null;
                channelName =
                  getString(profile?.display_name) ||
                  getString(u?.real_name) ||
                  getString(u?.name) ||
                  undefined;
              } catch {
                // ignore
              }
            }
          }
        }
      } catch {
        // ignore
      }

      // Fetch the actual message
      if (ts) {
        try {
          const history = await client.api("conversations.history", {
            channel: channelId,
            latest: ts,
            inclusive: true,
            limit: 1,
          });
          const msgs = asArray(history.messages).filter(isRecord);
          const msg = msgs.find((m) => getString(m.ts) === ts);
          if (msg) {
            const rendered = renderSlackMessageContent(msg);
            const content =
              maxBodyChars >= 0 && rendered.length > maxBodyChars
                ? `${rendered.slice(0, maxBodyChars)}\n…`
                : rendered;

            message = {
              author:
                getString(msg.user) || getString(msg.bot_id)
                  ? {
                      user_id: getString(msg.user) ?? undefined,
                      bot_id: getString(msg.bot_id) ?? undefined,
                    }
                  : undefined,
              content: content || undefined,
              thread_ts: getString(msg.thread_ts) ?? undefined,
              reply_count: getNumber(msg.reply_count) ?? undefined,
            };
          }
        } catch {
          // ignore — message may have been deleted
        }
      }

      return {
        channel_id: channelId,
        channel_name: channelName,
        ts,
        state,
        date_saved: dateSaved,
        date_completed: dateCompleted && dateCompleted > 0 ? dateCompleted : undefined,
        message,
      } satisfies LaterItem;
    }),
  );

  // Pagination cursor
  const meta = isRecord(resp.response_metadata) ? resp.response_metadata : null;
  const next = meta ? getString(meta.next_cursor) : undefined;
  if (next) {
    result.next_cursor = next;
  }

  return result;
}

/**
 * Mark a saved item as completed, archived, or reopen it.
 * Uses multipart/form-data with the `mark` param (not `state`).
 * Valid `mark` values: completed, uncompleted, archived, unarchived.
 */
export async function updateLaterMark(
  client: SlackApiClient,
  input: {
    channelId: string;
    ts: string;
    mark: "completed" | "uncompleted" | "archived" | "unarchived";
  },
): Promise<void> {
  await client.apiMultipart("saved.update", {
    item_id: input.channelId,
    item_type: "message",
    ts: input.ts,
    mark: input.mark,
  });
}

export async function saveLater(
  client: SlackApiClient,
  input: { channelId: string; ts: string },
): Promise<void> {
  await client.api("saved.add", {
    item_id: input.channelId,
    item_type: "message",
    ts: input.ts,
  });
}

export async function removeLater(
  client: SlackApiClient,
  input: { channelId: string; ts: string },
): Promise<void> {
  await client.api("saved.delete", {
    item_id: input.channelId,
    item_type: "message",
    ts: input.ts,
  });
}

export async function setLaterReminder(
  client: SlackApiClient,
  input: { channelId: string; ts: string; dateDue: number },
): Promise<void> {
  await client.apiMultipart("saved.update", {
    item_id: input.channelId,
    item_type: "message",
    ts: input.ts,
    date_due: String(input.dateDue),
  });
}

export function parseReminderDuration(input: string): number {
  const now = Math.floor(Date.now() / 1000);
  const trimmed = input.trim().toLowerCase();

  // Relative durations: 30m, 1h, 3h, 2d
  const relMatch = trimmed.match(/^(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/);
  if (relMatch) {
    const amount = Number.parseInt(relMatch[1]!, 10);
    const unit = relMatch[2]!.charAt(0);
    if (unit === "m") {
      return now + amount * 60;
    }
    if (unit === "h") {
      return now + amount * 3600;
    }
    if (unit === "d") {
      return now + amount * 86400;
    }
  }

  // Named times
  const tomorrow9am = getNext9am(1);
  if (trimmed === "tomorrow") {
    return tomorrow9am;
  }

  const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const dayIndex = dayNames.indexOf(trimmed);
  if (dayIndex >= 0) {
    const today = new Date();
    const currentDay = today.getDay();
    let daysUntil = dayIndex - currentDay;
    if (daysUntil <= 0) {
      daysUntil += 7;
    }
    return getNext9am(daysUntil);
  }

  // Unix timestamp passthrough
  const asNum = Number(trimmed);
  if (!Number.isNaN(asNum) && asNum > 1000000000) {
    return asNum;
  }

  throw new Error(
    `Invalid duration: "${input}". Use: 30m, 1h, 3h, 2d, tomorrow, monday, or a unix timestamp.`,
  );
}

function getNext9am(daysFromNow: number): number {
  const date = new Date();
  date.setDate(date.getDate() + daysFromNow);
  date.setHours(9, 0, 0, 0);
  return Math.floor(date.getTime() / 1000);
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
