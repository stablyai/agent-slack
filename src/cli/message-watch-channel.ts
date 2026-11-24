import type { CliContext } from "./context.ts";
import { fetchThread } from "../slack/messages.ts";
import { fetchHistoryWindow } from "../slack/history-window.ts";
import {
  CHANNEL_WINDOW,
  compareSlackTs,
  diffChannel,
  emptySnapshot,
  type ThreadSnapshot,
} from "../slack/thread-diff.ts";
import type { WatchConfig, WatchedThread } from "./message-watch.ts";

type SlackClient = Awaited<ReturnType<CliContext["getClientForWorkspace"]>>["client"];

export function withClient<T>(input: {
  ctx: CliContext;
  workspaceUrl: string;
  work: (client: SlackClient) => Promise<T>;
}): Promise<T> {
  const { ctx, workspaceUrl, work } = input;
  return ctx.withAutoRefresh({
    workspaceUrl,
    work: async () => work((await ctx.getClientForWorkspace(workspaceUrl)).client),
  });
}

/** Snapshot of a conversation's newest top-level messages; with --since, later ones stay unknown. */
export async function channelBaseline(input: {
  ctx: CliContext;
  workspaceUrl: string;
  channelId: string;
  since?: string;
}): Promise<ThreadSnapshot> {
  const { since } = input;
  const recent = await withClient({
    ctx: input.ctx,
    workspaceUrl: input.workspaceUrl,
    work: (client) =>
      fetchHistoryWindow(client, {
        channelId: input.channelId,
        limit: CHANNEL_WINDOW,
      }),
  });
  const known = since ? recent.filter((m) => compareSlackTs(m.ts, since) <= 0) : recent;
  const nowTs = `${Math.floor(Date.now() / 1000)}.000000`;
  const start = emptySnapshot({
    channelId: input.channelId,
    threadTs: "",
    cursor: since ?? known.at(-1)?.ts ?? nowTs,
  });
  return diffChannel(start, {
    messages: known,
    trackEdits: true,
    window: CHANNEL_WINDOW,
    baseline: true,
  }).next;
}

/**
 * One conversation poll. Most polls read only messages after the cursor (a
 * quiet read is ~140 bytes). A sweep re-reads the tracked window (~5 KB per
 * message) to catch edits, deletes and thread replies: on the first poll,
 * right after new messages, and at least every --max-interval.
 */
export function advanceChannel(input: {
  ctx: CliContext;
  t: WatchedThread & { workspaceUrl: string };
  cfg: WatchConfig;
  now?: () => number;
}) {
  const { ctx, t, cfg } = input;
  const now = input.now ?? Date.now;
  let sweepNext = true;
  let lastSweepAt = 0;
  return () =>
    withClient({
      ctx,
      workspaceUrl: t.workspaceUrl,
      work: async (client) => {
        const prev = t.snapshot;
        const sweep = sweepNext || now() - lastSweepAt >= cfg.maxIntervalMs;
        const oldest = sweep
          ? (Object.keys(prev.messages).sort(compareSlackTs)[0] ?? prev.cursor)
          : prev.cursor;
        const messages = await fetchHistoryWindow(client, {
          channelId: prev.channel_id,
          oldest,
          inclusive: sweep,
        });
        const { next, changes, replyChecks } = diffChannel(prev, {
          messages,
          trackEdits: cfg.trackEdits,
          window: CHANNEL_WINDOW,
          complete: sweep,
        });
        const seen = new Set(changes.added.map((m) => m.ts));
        for (const { root, after } of replyChecks) {
          const replies = await fetchThread(client, {
            channelId: prev.channel_id,
            threadTs: root,
            oldest: after,
            enrichFiles: false,
          });
          for (const r of replies) {
            // Broadcast replies also show up in history; report each message once.
            if (r.ts !== root && compareSlackTs(r.ts, after) > 0 && !seen.has(r.ts)) {
              seen.add(r.ts);
              changes.added.push(r);
            }
          }
        }
        changes.added.sort((a, b) => compareSlackTs(a.ts, b.ts));
        if (sweep) {
          lastSweepAt = now();
        }
        // New messages often draw a quick edit or thread reply: sweep on the next poll.
        sweepNext = !sweep && changes.added.length > 0;
        return { next, changes };
      },
    });
}
