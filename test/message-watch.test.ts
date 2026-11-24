import { describe, expect, test } from "bun:test";
import type { SlackMessageSummary } from "../src/slack/messages.ts";
import { baselineSnapshot, emptySnapshot } from "../src/slack/thread-diff.ts";
import { fetchThread } from "../src/slack/messages.ts";
import {
  parseDurationMs,
  runWatch,
  shouldReadFull,
  type WatchBatch,
  type WatchConfig,
  type WatchedThread,
} from "../src/cli/message-watch.ts";

const ROOT = "100.000001";

function m(ts: string, extra: Partial<SlackMessageSummary> = {}): SlackMessageSummary {
  return {
    channel_id: "C1",
    ts,
    thread_ts: ROOT,
    user: "U2",
    text: `t${ts}`,
    markdown: "",
    ...extra,
  };
}

function thread(
  messages: SlackMessageSummary[],
  extra: Partial<WatchedThread> = {},
): WatchedThread {
  return {
    key: "k1",
    snapshot: baselineSnapshot(emptySnapshot({ channelId: "C1", threadTs: ROOT }), messages),
    polls: 0,
    ...extra,
  };
}

const cfg = (extra: Partial<WatchConfig> = {}): WatchConfig => ({
  trackEdits: true,
  baseIntervalMs: 10_000,
  maxIntervalMs: 60_000,
  settleMs: 0,
  maxSettleMs: 120_000,
  fullReadEvery: 10,
  once: true,
  ...extra,
});

/** Fake clock: sleep advances time; each poll returns the thread as it is at that moment. */
function harness(timeline: (t: number) => SlackMessageSummary[]) {
  let clock = 0;
  const sleeps: number[] = [];
  const polls: { at: number; oldest?: string }[] = [];
  const batches: WatchBatch[] = [];
  const persisted: number[] = [];
  return {
    sleeps,
    polls,
    batches,
    persisted,
    io: {
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
      poll: async (_t: WatchedThread, opts: { oldest?: string }) => {
        polls.push({ at: clock, oldest: opts.oldest });
        return timeline(clock);
      },
      flush: async (b: WatchBatch) => {
        batches.push(b);
      },
      persist: async () => {
        persisted.push(clock);
      },
    },
  };
}

describe("parseDurationMs", () => {
  test("accepts bare seconds and unit suffixes", () => {
    expect(parseDurationMs("90", "--x")).toBe(90_000);
    expect(parseDurationMs("2h", "--x")).toBe(7_200_000);
    expect(() => parseDurationMs("soon", "--timeout")).toThrow("--timeout");
  });
});

describe("runWatch", () => {
  test("idle polls back off to the ceiling", async () => {
    const h = harness(() => [m(ROOT)]);
    const result = await runWatch({
      threads: [thread([m(ROOT)])],
      cfg: cfg({ timeoutMs: 200_000 }),
      ...h.io,
    });
    expect(result).toEqual({ reason: "timeout", updates: 0 });
    expect(h.sleeps.slice(0, 6)).toEqual([10_000, 15_000, 22_500, 33_750, 50_625, 60_000]);
  });

  test("a burst within --settle becomes one batch, then --once exits", async () => {
    const h = harness((t) => [
      m(ROOT),
      ...(t >= 10_000 ? [m("101.0")] : []),
      ...(t >= 20_000 ? [m("102.0")] : []),
    ]);
    const result = await runWatch({
      threads: [thread([m(ROOT)])],
      cfg: cfg({ settleMs: 15_000 }),
      ...h.io,
    });
    expect(result).toEqual({ reason: "once", updates: 1 });
    expect(h.batches).toHaveLength(1);
    expect(h.batches[0]![0]!.changes.added.map((x) => x.ts)).toEqual(["101.0", "102.0"]);
  });

  test("own API posts are skipped but still advance the cursor and get persisted", async () => {
    const h = harness((t) => [m(ROOT), ...(t >= 10_000 ? [m("101.0", { user: "ME" })] : [])]);
    const t = thread([m(ROOT)], { skipUserId: "ME" });
    await runWatch({ threads: [t], cfg: cfg({ timeoutMs: 30_000 }), ...h.io });
    expect(h.batches).toHaveLength(0);
    expect(t.snapshot.cursor).toBe("101.0");
    expect(h.persisted.length).toBeGreaterThan(0);
  });

  test("state is not persisted while a batch is pending", async () => {
    const h = harness((t) => [m(ROOT), ...(t >= 10_000 ? [m("101.0")] : [])]);
    await runWatch({ threads: [thread([m(ROOT)])], cfg: cfg({ settleMs: 15_000 }), ...h.io });
    const flushAt = h.polls.at(-1)!.at;
    expect(h.persisted.length).toBeGreaterThan(0);
    expect(h.persisted.every((at) => at >= flushAt)).toBe(true);
  });

  test("timeout flushes a pending batch instead of dropping it", async () => {
    const h = harness((t) => [m(ROOT), ...(t >= 10_000 ? [m("101.0")] : [])]);
    const result = await runWatch({
      threads: [thread([m(ROOT)])],
      cfg: cfg({ settleMs: 60_000, once: false, timeoutMs: 20_000 }),
      ...h.io,
    });
    expect(result).toEqual({ reason: "timeout", updates: 1 });
  });

  test("errors back off exponentially and recover", async () => {
    let calls = 0;
    const h = harness(() => [m(ROOT)]);
    const errors: unknown[] = [];
    await runWatch({
      threads: [thread([m(ROOT)])],
      cfg: cfg({ timeoutMs: 100_000 }),
      ...h.io,
      poll: async () => {
        calls++;
        if (calls <= 2) {
          throw new Error("ratelimited");
        }
        return [m(ROOT)];
      },
      onError: (_t, e) => errors.push(e),
    });
    expect(errors).toHaveLength(2);
    expect(h.sleeps.slice(0, 3)).toEqual([20_000, 40_000, 10_000]);
  });

  test("small threads read in full; --no-edits reads incrementally from the cursor", async () => {
    const h = harness(() => [m(ROOT)]);
    await runWatch({ threads: [thread([m(ROOT)])], cfg: cfg({ timeoutMs: 1 }), ...h.io });
    expect(h.polls[0]!.oldest).toBeUndefined();
    const h2 = harness(() => [m(ROOT)]);
    await runWatch({
      threads: [thread([m(ROOT)])],
      cfg: cfg({ timeoutMs: 1, trackEdits: false }),
      ...h2.io,
    });
    expect(h2.polls[0]!.oldest).toBe(ROOT);
  });
});

describe("shouldReadFull", () => {
  test("large threads go incremental with a periodic full sweep", () => {
    const t = thread([m(ROOT, { reply_count: 500 })]);
    const picks = Array.from({ length: 11 }, (_, i) => shouldReadFull({ ...t, polls: i }, cfg()));
    expect(picks.filter(Boolean)).toHaveLength(2);
    expect(picks[0]).toBe(true);
    expect(picks[10]).toBe(true);
  });
});

describe("fetchThread", () => {
  test("passes an exclusive oldest bound and skips files.info when enrichFiles is false", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const client = {
      api: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        return {
          messages: [
            { ts: "2.0", text: "x", edited: { ts: "3.0" }, files: [{ id: "F1", mode: "snippet" }] },
          ],
        };
      },
    };
    const out = await fetchThread(client as never, {
      channelId: "C1",
      threadTs: "1.0",
      oldest: "2.0",
      enrichFiles: false,
    });
    expect(calls.map((c) => c.method)).toEqual(["conversations.replies"]);
    expect(calls[0]!.params).toMatchObject({ oldest: "2.0", inclusive: false });
    expect(out[0]!.edited_ts).toBe("3.0");
  });
});

describe("runWatch advance hook", () => {
  test("a thread with advance skips poll and diffThread", async () => {
    const h = harness(() => []);
    const t = thread([m("100.000002")]);
    let calls = 0;
    t.advance = async () => {
      calls++;
      return {
        next: { ...t.snapshot, cursor: "100.000009" },
        changes: { added: [m("100.000009")], edited: [], deleted: [] },
      };
    };
    const res = await runWatch({ threads: [t], cfg: cfg(), ...h.io });
    expect(res.reason).toBe("once");
    expect(calls).toBe(1);
    expect(h.polls).toEqual([]);
    expect(h.batches[0]![0]!.changes.added.map((x) => x.ts)).toEqual(["100.000009"]);
    expect(t.snapshot.cursor).toBe("100.000009");
  });
});
