import type { SlackApiClient } from "./client.ts";
import { asArray, getNumber, getString, isRecord } from "../lib/object-type-guards.ts";

const MAX_SCHEDULE_SECONDS = 120 * 24 * 60 * 60;
const DEFAULT_NAMED_TIME = { hour: 9, minute: 0 };

type Clock = {
  now?: Date;
};

export type ScheduledMessage = Record<string, unknown>;

export async function listScheduledMessages(
  client: SlackApiClient,
  options?: {
    channelId?: string;
    cursor?: string;
    oldest?: string;
    latest?: string;
    limit?: number;
  },
): Promise<{
  ok: true;
  scheduled_messages: ScheduledMessage[];
  next_cursor?: string;
}> {
  const resp = await client.api("chat.scheduledMessages.list", {
    channel: options?.channelId,
    cursor: options?.cursor,
    oldest: options?.oldest,
    latest: options?.latest,
    limit: options?.limit,
  });
  const meta = isRecord(resp.response_metadata) ? resp.response_metadata : null;
  const nextCursor = meta ? getString(meta.next_cursor) : undefined;
  return {
    ok: true,
    scheduled_messages: asArray(resp.scheduled_messages).filter(isRecord),
    next_cursor: nextCursor,
  };
}

export async function cancelScheduledMessage(
  client: SlackApiClient,
  input: { channelId: string; scheduledMessageId: string },
): Promise<void> {
  await client.api("chat.deleteScheduledMessage", {
    channel: input.channelId,
    scheduled_message_id: input.scheduledMessageId,
  });
}

export function resolveSchedulePostAt(
  input: { schedule?: string; scheduleIn?: string },
  clock?: Clock,
): number | undefined {
  const at = input.schedule?.trim();
  const within = input.scheduleIn?.trim();
  if (at && within) {
    throw new Error("--schedule and --schedule-in are mutually exclusive.");
  }
  if (!at && !within) {
    return undefined;
  }

  const postAt = at ? parseAbsoluteSchedule(at) : parseRelativeSchedule(within ?? "", clock);
  validatePostAt(postAt, clock);
  return postAt;
}

export function parseAbsoluteSchedule(input: string): number {
  const trimmed = input.trim();
  const unix = parseUnixTimestamp(trimmed);
  if (unix !== undefined) {
    return unix;
  }

  if (!hasExplicitIsoTimezone(trimmed)) {
    throw new Error(
      `Invalid --schedule value "${input}". Use an ISO 8601 timestamp with an explicit timezone (YYYY-MM-DDTHH:mm:ss-07:00), or a Unix timestamp.`,
    );
  }

  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) {
    throw new Error(
      `Invalid --schedule value "${input}". Use an ISO 8601 timestamp with an explicit timezone (YYYY-MM-DDTHH:mm:ss-07:00), or a Unix timestamp.`,
    );
  }
  return Math.floor(ms / 1000);
}

export function parseRelativeSchedule(input: string, clock?: Clock): number {
  const now = clock?.now ? new Date(clock.now) : new Date();
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) {
    throw new Error(
      'Invalid --schedule-in value "". Use: 30m, 1h, 3h, 2d, tomorrow 9am, monday 9am, or a Unix timestamp.',
    );
  }

  const unix = parseUnixTimestamp(trimmed);
  if (unix !== undefined) {
    return unix;
  }

  const relMatch = trimmed.match(
    /^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|day|days?)$/,
  );
  if (relMatch) {
    const amount = Number.parseFloat(relMatch[1]!);
    const unit = relMatch[2]!.charAt(0);
    const seconds = unit === "m" ? amount * 60 : unit === "h" ? amount * 3600 : amount * 86400;
    return Math.floor(now.getTime() / 1000 + seconds);
  }

  const named = parseNamedFutureTime(trimmed, now);
  if (named !== undefined) {
    return named;
  }

  throw new Error(
    `Invalid --schedule-in value "${input}". Use: 30m, 1h, 3h, 2d, tomorrow 9am, monday 9am, or a Unix timestamp.`,
  );
}

export function normalizeScheduleLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const limit = Number.parseInt(raw, 10);
  if (!Number.isFinite(limit) || limit < 1) {
    throw new Error(`Invalid --limit value "${raw}": must be a positive integer`);
  }
  return limit;
}

function validatePostAt(postAt: number, clock?: Clock): void {
  const now = Math.floor((clock?.now ? clock.now.getTime() : Date.now()) / 1000);
  if (!Number.isFinite(postAt) || postAt <= now) {
    throw new Error("--schedule/--schedule-in must resolve to a future time.");
  }
  if (postAt > now + MAX_SCHEDULE_SECONDS) {
    throw new Error("--schedule/--schedule-in cannot be more than 120 days in the future.");
  }
}

function parseUnixTimestamp(input: string): number | undefined {
  if (!/^\d+(?:\.\d+)?$/.test(input)) {
    return undefined;
  }
  const n = Number(input);
  if (!Number.isFinite(n) || n < 1_000_000_000) {
    return undefined;
  }
  return Math.floor(n);
}

function hasExplicitIsoTimezone(input: string): boolean {
  return /^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}/i.test(input) && /(?:z|[+-]\d{2}:?\d{2})$/i.test(input);
}

function parseNamedFutureTime(input: string, now: Date): number | undefined {
  const parts = input.split(/\s+/).filter(Boolean);
  if (parts.length < 1 || parts.length > 3) {
    return undefined;
  }

  const hasNext = parts[0] === "next";
  const dayToken = hasNext ? parts[1] : parts[0];
  const timeText = hasNext ? parts.slice(2).join(" ") : parts.slice(1).join(" ");
  if (!dayToken) {
    return undefined;
  }

  const time = timeText ? parseTimeOfDay(timeText) : DEFAULT_NAMED_TIME;
  if (!time) {
    return undefined;
  }

  if (dayToken === "today") {
    const date = withLocalTime({ base: now, daysFromNow: 0, time });
    return date.getTime() > now.getTime() ? Math.floor(date.getTime() / 1000) : undefined;
  }

  if (dayToken === "tomorrow" || dayToken === "tmrw") {
    return Math.floor(withLocalTime({ base: now, daysFromNow: 1, time }).getTime() / 1000);
  }

  const targetDay = weekdayIndex(dayToken);
  if (targetDay === undefined) {
    return undefined;
  }

  const currentDay = now.getDay();
  let daysUntil = targetDay - currentDay;
  if (daysUntil < 0 || hasNext) {
    daysUntil += 7;
  }

  let candidate = withLocalTime({ base: now, daysFromNow: daysUntil, time });
  if (candidate.getTime() <= now.getTime()) {
    candidate = withLocalTime({ base: now, daysFromNow: daysUntil + 7, time });
  }
  return Math.floor(candidate.getTime() / 1000);
}

function parseTimeOfDay(input: string): { hour: number; minute: number } | undefined {
  const normalized = input.trim().toLowerCase().replace(/\s+/g, "");
  if (normalized === "noon") {
    return { hour: 12, minute: 0 };
  }
  if (normalized === "midnight") {
    return { hour: 0, minute: 0 };
  }

  const match = normalized.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?$/);
  if (!match) {
    return undefined;
  }
  const [, hourRaw, minuteRaw, meridiem] = match;
  let hour = Number.parseInt(hourRaw!, 10);
  const minute = minuteRaw ? Number.parseInt(minuteRaw, 10) : 0;
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return undefined;
  }

  if (meridiem) {
    if (hour < 1 || hour > 12) {
      return undefined;
    }
    if (meridiem === "am") {
      hour = hour === 12 ? 0 : hour;
    } else {
      hour = hour === 12 ? 12 : hour + 12;
    }
  } else if (hour < 0 || hour > 23) {
    return undefined;
  }

  return { hour, minute };
}

function withLocalTime(input: {
  base: Date;
  daysFromNow: number;
  time: { hour: number; minute: number };
}): Date {
  const { base, daysFromNow, time } = input;
  const date = new Date(base);
  date.setDate(base.getDate() + daysFromNow);
  date.setHours(time.hour, time.minute, 0, 0);
  return date;
}

function weekdayIndex(input: string): number | undefined {
  const days = new Map<string, number>([
    ["sun", 0],
    ["sunday", 0],
    ["mon", 1],
    ["monday", 1],
    ["tue", 2],
    ["tues", 2],
    ["tuesday", 2],
    ["wed", 3],
    ["wednesday", 3],
    ["thu", 4],
    ["thur", 4],
    ["thurs", 4],
    ["thursday", 4],
    ["fri", 5],
    ["friday", 5],
    ["sat", 6],
    ["saturday", 6],
  ]);
  return getNumber(days.get(input));
}
