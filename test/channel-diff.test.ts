import { describe, expect, test } from "bun:test";
import type { SlackMessageSummary } from "../src/slack/messages.ts";
import { diffChannel, emptySnapshot, type ThreadSnapshot } from "../src/slack/thread-diff.ts";

function m(ts: string, extra: Partial<SlackMessageSummary> = {}): SlackMessageSummary {
  return { channel_id: "D1", ts, user: "U2", text: `t${ts}`, markdown: "", ...extra };
}

function base(messages: SlackMessageSummary[], window = 3): ThreadSnapshot {
  const start = emptySnapshot({ channelId: "D1", threadTs: "", cursor: "1.000000" });
  return diffChannel(start, { messages, trackEdits: true, window, baseline: true }).next;
}

describe("diffChannel", () => {
  test("baseline keeps only the newest window and reports nothing", () => {
    const snap = base([m("1.1"), m("1.2"), m("1.3"), m("1.4")]);
    expect(Object.keys(snap.messages)).toEqual(["1.2", "1.3", "1.4"]);
    expect(snap.cursor).toBe("1.4");
    expect(snap.kind).toBe("channel");
  });

  test("reports new top-level, edits and deletes inside the window", () => {
    const prev = base([m("1.2"), m("1.3"), m("1.4")]);
    const { next, changes } = diffChannel(prev, {
      messages: [m("1.2"), m("1.4", { text: "fixed", edited_ts: "9.0" }), m("1.5")],
      trackEdits: true,
      window: 3,
    });
    expect(changes.added.map((x) => x.ts)).toEqual(["1.5"]);
    expect(changes.edited.map((e) => [e.msg.ts, e.before])).toEqual([["1.4", "t1.4"]]);
    expect(changes.deleted.map((d) => d.ts)).toEqual(["1.3"]);
    expect(Object.keys(next.messages)).toEqual(["1.2", "1.4", "1.5"]);
  });

  test("asks for replies when a root's latest_reply moves, including a root's first reply", () => {
    const prev = base([m("1.2", { latest_reply: "1.21", reply_count: 1 }), m("1.3")]);
    expect(prev.latest_replies).toEqual({ "1.2": "1.21" });
    const { next, replyChecks } = diffChannel(prev, {
      messages: [
        m("1.2", { latest_reply: "1.25", reply_count: 2 }),
        m("1.3", { latest_reply: "1.31", reply_count: 1 }),
        // A broadcast reply is not a root.
        m("1.4", { thread_ts: "1.2", latest_reply: "1.4" }),
      ],
      trackEdits: true,
      window: 3,
    });
    expect(replyChecks).toEqual([
      { root: "1.2", after: "1.21" },
      { root: "1.3", after: "1.3" },
    ]);
    expect(next.latest_replies).toEqual({ "1.2": "1.25", "1.3": "1.31" });
  });

  test("a new root that already has replies asks for all of them", () => {
    const prev = base([m("1.2")]);
    const { changes, replyChecks } = diffChannel(prev, {
      messages: [m("1.2"), m("1.5", { latest_reply: "1.51", reply_count: 1 })],
      trackEdits: true,
      window: 3,
    });
    expect(changes.added.map((x) => x.ts)).toEqual(["1.5"]);
    expect(replyChecks).toEqual([{ root: "1.5", after: "1.5" }]);
  });

  test("--no-edits still reports new messages but no edits or deletes", () => {
    const prev = base([m("1.2"), m("1.3")]);
    const { changes } = diffChannel(prev, {
      messages: [m("1.3", { text: "x", edited_ts: "9.0" }), m("1.4")],
      trackEdits: false,
      window: 3,
    });
    expect(changes.added.map((x) => x.ts)).toEqual(["1.4"]);
    expect(changes.edited).toEqual([]);
    expect(changes.deleted).toEqual([]);
  });
});

describe("diffChannel incremental", () => {
  test("adds new messages, deletes nothing, keeps known reply marks", () => {
    const prev = base([m("1.2", { latest_reply: "1.21" }), m("1.3")]);
    const { next, changes } = diffChannel(prev, {
      messages: [m("1.4")],
      trackEdits: true,
      window: 3,
      complete: false,
    });
    expect(changes.added.map((x) => x.ts)).toEqual(["1.4"]);
    expect(changes.deleted).toEqual([]);
    expect(Object.keys(next.messages)).toEqual(["1.2", "1.3", "1.4"]);
    expect(next.latest_replies).toEqual({ "1.2": "1.21" });
  });
});
