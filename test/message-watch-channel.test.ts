import { describe, expect, test } from "bun:test";
import type { CliContext } from "../src/cli/context.ts";
import { advanceChannel } from "../src/cli/message-watch-channel.ts";
import { diffChannel, emptySnapshot } from "../src/slack/thread-diff.ts";
import type { WatchConfig, WatchedThread } from "../src/cli/message-watch.ts";

type Raw = { ts: string; text: string; user: string; client_msg_id?: string };

/** Fake history: `history` returns newest-first, honouring oldest/inclusive. */
function fakeCtx(messages: Raw[], calls: Record<string, unknown>[]) {
  const client = {
    api: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, ...params });
      const oldest = params.oldest as string | undefined;
      const inclusive = params.inclusive as boolean | undefined;
      const hit = messages.filter((x) =>
        !oldest ? true : inclusive ? Number(x.ts) >= Number(oldest) : Number(x.ts) > Number(oldest),
      );
      return { ok: true, messages: [...hit].reverse() };
    },
  };
  return {
    withAutoRefresh: ({ work }: { work: () => Promise<unknown> }) => work(),
    getClientForWorkspace: async () => ({ client }),
  } as unknown as CliContext;
}

describe("advanceChannel", () => {
  test("sweeps first, reads incrementally, sweeps after new messages and every max-interval", async () => {
    const msgs: Raw[] = [{ ts: "1.1", text: "a", user: "U2" }];
    const calls: Record<string, unknown>[] = [];
    const start = emptySnapshot({ channelId: "D1", threadTs: "", cursor: "1.1" });
    const snapshot = diffChannel(start, {
      messages: [{ channel_id: "D1", ts: "1.1", text: "a", user: "U2", markdown: "" }],
      trackEdits: true,
      window: 20,
      baseline: true,
    }).next;
    const t = { key: "k", snapshot, polls: 0, workspaceUrl: "w" } as WatchedThread & {
      workspaceUrl: string;
    };
    let clock = 1_000_000;
    const cfg = { trackEdits: true, maxIntervalMs: 120_000 } as WatchConfig;
    const advance = advanceChannel({ ctx: fakeCtx(msgs, calls), t, cfg, now: () => clock });
    const step = async () => {
      const r = await advance();
      t.snapshot = r.next;
      clock += 15_000;
      return r.changes;
    };
    const kinds = () => calls.map((c) => (c.inclusive ? "sweep" : "incr"));

    await step(); // first poll sweeps
    await step(); // quiet: incremental
    msgs.push({ ts: "1.2", text: "b", user: "U2", client_msg_id: "x" });
    const c3 = await step(); // incremental sees the new message
    expect(c3.added.map((x) => x.ts)).toEqual(["1.2"]);
    await step(); // sweep right after new messages
    for (let i = 0; i < 7; i++) {
      await step();
    }
    expect(kinds()).toEqual([
      "sweep",
      "incr",
      "incr",
      "sweep",
      "incr",
      "incr",
      "incr",
      "incr",
      "incr",
      "incr",
      "incr",
    ]);
    await step(); // 120s since the last sweep
    expect(kinds().at(-1)).toBe("sweep");
  });
});
