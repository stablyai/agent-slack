import type { SlackMessageSummary } from "../slack/messages.ts";
import {
  diffThread,
  hasChanges,
  mergeChanges,
  withoutOwnApiChanges,
  type ThreadChanges,
  type ThreadSnapshot,
} from "../slack/thread-diff.ts";

export { compareSlackTs } from "../slack/thread-diff.ts";

/** Above this many replies a full read needs several pages, so polls go incremental. */
export const FULL_READ_MAX_REPLIES = 199;
const MAX_ERROR_BACKOFF_MS = 5 * 60_000;
const IDLE_GROWTH = 1.5;

/** Parses "90", "90s", "30m", "2h" or "1d" into milliseconds. */
export function parseDurationMs(value: string, flag: string): number {
  const m = /^(\d+)\s*([smhd]?)$/i.exec(value.trim());
  if (!m) {
    throw new Error(`${flag} must be a number of seconds or a duration like 30m, 2h, 1d`);
  }
  const n = Number.parseInt(m[1]!, 10);
  const unit = (m[2] || "s").toLowerCase();
  const mult = unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1000;
  return n * mult;
}

export type WatchedThread = {
  key: string;
  snapshot: ThreadSnapshot;
  skipUserId?: string;
  polls: number;
  // Replaces poll + diffThread, e.g. for a conversation watch.
  advance?: (full: boolean) => Promise<{ next: ThreadSnapshot; changes: ThreadChanges }>;
};

export type WatchBatch = { thread: WatchedThread; changes: ThreadChanges }[];

export type WatchResult = { reason: "once" | "timeout"; updates: number };

export type WatchConfig = {
  trackEdits: boolean;
  baseIntervalMs: number;
  maxIntervalMs: number;
  // Quiet time after the last change before a batch is flushed.
  settleMs: number;
  // Hard cap on how long a batch can keep growing.
  maxSettleMs: number;
  // Large threads poll incrementally; every Nth poll is a full read to catch edits.
  fullReadEvery: number;
  once: boolean;
  timeoutMs?: number;
};

/** Whether this poll should read the whole thread (sees edits and deletes) or only replies after the cursor. */
export function shouldReadFull(thread: WatchedThread, cfg: WatchConfig): boolean {
  if (!cfg.trackEdits) {
    return false;
  }
  const replies = thread.snapshot.reply_count ?? 0;
  return replies <= FULL_READ_MAX_REPLIES || thread.polls % cfg.fullReadEvery === 0;
}

/**
 * Polls every thread, batches what changed and hands each batch to `flush`.
 * Polls back off while the threads are quiet and snap back to the base
 * interval on any change; a batch waits `settleMs` of quiet so a burst of
 * replies costs one wake. Snapshots are persisted only once nothing is
 * pending, so a killed watch re-reports instead of losing changes.
 */
export async function runWatch(input: {
  threads: WatchedThread[];
  cfg: WatchConfig;
  poll: (thread: WatchedThread, opts: { oldest?: string }) => Promise<SlackMessageSummary[]>;
  flush: (batch: WatchBatch) => Promise<void>;
  persist: (thread: WatchedThread) => Promise<void>;
  onError?: (thread: WatchedThread, err: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<WatchResult> {
  const { cfg, threads } = input;
  const sleep = input.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = input.now ?? Date.now;
  const deadline = cfg.timeoutMs !== undefined ? now() + cfg.timeoutMs : undefined;
  const pending = new Map<string, ThreadChanges>();
  const dirty = new Set<WatchedThread>();
  let idleMs = cfg.baseIntervalMs;
  let failures = 0;
  let updates = 0;
  let firstChangeAt: number | undefined;
  let lastChangeAt: number | undefined;

  const flushPending = async (): Promise<void> => {
    const batch: WatchBatch = threads
      .filter((t) => pending.has(t.key))
      .map((t) => ({ thread: t, changes: pending.get(t.key)! }));
    await input.flush(batch);
    updates++;
    pending.clear();
    firstChangeAt = undefined;
    lastChangeAt = undefined;
  };
  const persistDirty = async (): Promise<void> => {
    for (const t of dirty) {
      await input.persist(t);
    }
    dirty.clear();
  };

  for (;;) {
    let changed = false;
    let failed = 0;
    await Promise.all(
      threads.map(async (t) => {
        try {
          const full = shouldReadFull(t, cfg);
          const { next, changes } = t.advance
            ? await t.advance(full)
            : diffThread(t.snapshot, {
                messages: await input.poll(t, full ? {} : { oldest: t.snapshot.cursor }),
                complete: full,
                trackEdits: cfg.trackEdits,
              });
          t.polls++;
          if (next.cursor !== t.snapshot.cursor || hasChanges(changes)) {
            dirty.add(t);
          }
          t.snapshot = next;
          const reportable = withoutOwnApiChanges(changes, t.skipUserId);
          if (hasChanges(reportable)) {
            const prior = pending.get(t.key);
            pending.set(t.key, prior ? mergeChanges(prior, reportable) : reportable);
            changed = true;
          }
        } catch (err: unknown) {
          failed++;
          input.onError?.(t, err);
        }
      }),
    );

    const at = now();
    if (changed) {
      firstChangeAt ??= at;
      lastChangeAt = at;
      idleMs = cfg.baseIntervalMs;
    }
    failures = failed === threads.length ? failures + 1 : 0;

    const settled =
      lastChangeAt !== undefined &&
      (at - lastChangeAt >= cfg.settleMs || at - firstChangeAt! >= cfg.maxSettleMs);
    if (pending.size > 0 && settled) {
      await flushPending();
      await persistDirty();
      if (cfg.once) {
        return { reason: "once", updates };
      }
    } else if (pending.size === 0) {
      await persistDirty();
    }

    let waitMs: number;
    if (failures > 0) {
      waitMs = Math.min(cfg.baseIntervalMs * 2 ** failures, MAX_ERROR_BACKOFF_MS);
    } else if (pending.size > 0) {
      const sinceLast = at - lastChangeAt!;
      const sinceFirst = at - firstChangeAt!;
      waitMs = Math.max(1, Math.min(cfg.settleMs - sinceLast, cfg.maxSettleMs - sinceFirst));
    } else {
      waitMs = idleMs;
      idleMs = Math.min(Math.round(idleMs * IDLE_GROWTH), cfg.maxIntervalMs);
    }

    if (deadline !== undefined) {
      const remaining = deadline - now();
      if (remaining <= 0) {
        if (pending.size > 0) {
          await flushPending();
        }
        await persistDirty();
        return { reason: "timeout", updates };
      }
      waitMs = Math.min(waitMs, remaining);
    }
    await sleep(waitMs);
  }
}
