import type { SlackApiClient } from "./client.ts";
import { asArray, getString, isRecord } from "../lib/object-type-guards.ts";
import { toSlackFileSummary } from "./message-api-parsing.ts";
import { summarizeRaw, type SlackFileSummary, type SlackMessageSummary } from "./messages.ts";

/**
 * Top-level messages for a watch, without file lookups: the newest `limit`
 * (one page), or every message at or after `oldest` (all pages; `inclusive: false` for after).
 */
export async function fetchHistoryWindow(
  client: SlackApiClient,
  input: { channelId: string; oldest?: string; inclusive?: boolean; limit?: number },
): Promise<SlackMessageSummary[]> {
  const out: SlackMessageSummary[] = [];
  let cursor: string | undefined;
  for (;;) {
    const resp = await client.api("conversations.history", {
      channel: input.channelId,
      limit: input.limit ?? 200,
      cursor,
      ...(input.oldest ? { oldest: input.oldest, inclusive: input.inclusive ?? true } : {}),
    });
    for (const m of asArray(resp.messages)) {
      if (!isRecord(m)) {
        continue;
      }
      const files = asArray(m.files)
        .map((f) => toSlackFileSummary(f))
        .filter((f): f is SlackFileSummary => f !== null);
      out.push(
        summarizeRaw({
          m,
          channelId: input.channelId,
          files: files.length > 0 ? files : undefined,
        }),
      );
    }
    const meta = isRecord(resp.response_metadata) ? resp.response_metadata : null;
    const next = meta ? getString(meta.next_cursor) : undefined;
    if (input.limit || !next) {
      break;
    }
    cursor = next;
  }
  return out.reverse();
}
