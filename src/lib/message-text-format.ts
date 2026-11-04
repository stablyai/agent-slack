import type { CompactSlackMessage } from "../slack/message-compact.ts";
import type { CompactSlackUser } from "../slack/users.ts";

export type OutputFormat = "json" | "text";

export function parseOutputFormat(raw: string | undefined): OutputFormat {
  const value = (raw ?? "json").trim().toLowerCase();
  if (value === "json" || value === "text") {
    return value;
  }
  throw new Error(`Invalid --format value "${raw}": must be "json" or "text"`);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function formatLocalTs(ts: string): string {
  const d = new Date(Number.parseFloat(ts) * 1000);
  if (Number.isNaN(d.getTime())) {
    return ts;
  }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function authorLabel(
  message: Pick<CompactSlackMessage, "author">,
  users: Record<string, CompactSlackUser> | undefined,
): string {
  const id = message.author?.user_id ?? message.author?.bot_id;
  if (!id) {
    return "unknown";
  }
  const user = users?.[id];
  return user?.display_name || user?.real_name || user?.name || id;
}

/** One line per message: `<local time> <author> [reply] <text>`, newlines collapsed. */
export function formatMessagesText(
  messages: Pick<CompactSlackMessage, "ts" | "thread_ts" | "author" | "content">[],
  users?: Record<string, CompactSlackUser>,
): string {
  return messages
    .map((m) => {
      const isReply = m.thread_ts !== undefined && m.thread_ts !== m.ts;
      const text = (m.content ?? "").replace(/\s*\n\s*/g, " ").trim();
      return [formatLocalTs(m.ts), authorLabel(m, users), isReply ? "[reply]" : "", text]
        .filter(Boolean)
        .join(" ");
    })
    .join("\n");
}

/** Renders a `message get` / `message list` payload in the requested format. */
export function renderMessagePayload(payload: Record<string, unknown>, format: OutputFormat) {
  if (format === "json") {
    return JSON.stringify(payload, null, 2);
  }
  const messages = (payload.messages ?? (payload.message ? [payload.message] : [])) as Parameters<
    typeof formatMessagesText
  >[0];
  return formatMessagesText(
    messages,
    payload.referenced_users as Record<string, CompactSlackUser> | undefined,
  );
}
