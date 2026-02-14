import type { CompactSlackMessage } from "../slack/messages.ts";
import { asArray, isRecord } from "../lib/object-type-guards.ts";

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export async function getThreadSummary(
  client: { api: (method: string, params?: Record<string, unknown>) => Promise<unknown> },
  input: {
    channelId: string;
    msg: { ts: string; thread_ts?: string; reply_count?: number };
  },
): Promise<{ ts: string; length: number } | null> {
  const replyCount = input.msg.reply_count ?? 0;
  const rootTs = input.msg.thread_ts ?? (replyCount > 0 ? input.msg.ts : null);
  if (!rootTs) {
    return null;
  }

  if (!input.msg.thread_ts && replyCount > 0) {
    return { ts: rootTs, length: 1 + replyCount };
  }

  const resp = await client.api("conversations.replies", {
    channel: input.channelId,
    ts: rootTs,
    limit: 1,
  });
  const [root] = asArray(isRecord(resp) ? resp.messages : undefined);
  const rootReplyCount = isRecord(root) ? getNumber(root.reply_count) : undefined;
  if (rootReplyCount === undefined) {
    return { ts: rootTs, length: 1 };
  }
  return { ts: rootTs, length: 1 + rootReplyCount };
}

export function toThreadListMessage(
  m: CompactSlackMessage,
): Omit<CompactSlackMessage, "channel_id" | "thread_ts"> {
  const { channel_id: _channelId, thread_ts: _threadTs, ...rest } = m;
  return rest;
}
