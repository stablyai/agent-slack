import { describe, expect, test } from "bun:test";
import type { SlackMessageSummary } from "../src/slack/messages.ts";
import {
  baselineSnapshot,
  compareSlackTs,
  diffThread,
  emptySnapshot,
  mergeChanges,
  withoutOwnApiChanges,
} from "../src/slack/thread-diff.ts";

const ROOT = "100.000001";

function m(ts: string, extra: Partial<SlackMessageSummary> = {}): SlackMessageSummary {
  return {
    channel_id: "C1",
    ts,
    thread_ts: ROOT,
    user: "U2",
    text: `text ${ts}`,
    markdown: "",
    ...extra,
  };
}

const base = () =>
  baselineSnapshot(emptySnapshot({ channelId: "C1", threadTs: ROOT }), [
    m(ROOT, { reply_count: 2 }),
    m("101.000000"),
    m("102.000000", { client_msg_id: "abc" }),
  ]);

describe("compareSlackTs", () => {
  test("compares micros exactly", () => {
    expect(compareSlackTs("1700000000.000002", "1700000000.000001")).toBe(1);
    expect(compareSlackTs("999.9", "1000.0")).toBe(-1);
    expect(compareSlackTs("1.5", "1.500000")).toBe(0);
  });
});

describe("diffThread", () => {
  test("baseline reports nothing and records cursor and reply_count", () => {
    const snap = base();
    expect(snap.cursor).toBe("102.000000");
    expect(snap.reply_count).toBe(2);
    expect(Object.keys(snap.messages)).toHaveLength(3);
    expect(snap.messages["101.000000"]!.api).toBe(true);
    expect(snap.messages["102.000000"]!.api).toBe(false);
  });

  test("full read finds new, edited and deleted messages", () => {
    const { next, changes } = diffThread(base(), {
      messages: [
        m(ROOT, { reply_count: 2 }),
        m("102.000000", { client_msg_id: "abc", text: "fixed", edited_ts: "105.0" }),
        m("103.000000"),
      ],
      complete: true,
      trackEdits: true,
    });
    expect(changes.added.map((x) => x.ts)).toEqual(["103.000000"]);
    expect(changes.edited.map((e) => [e.msg.text, e.before])).toEqual([
      ["fixed", "text 102.000000"],
    ]);
    expect(changes.deleted.map((d) => d.ts)).toEqual(["101.000000"]);
    expect(next.cursor).toBe("103.000000");
    expect(next.messages["101.000000"]).toBeUndefined();
  });

  test("reaction, unfurl or reply_count changes are not edits", () => {
    const { changes } = diffThread(base(), {
      messages: [
        m(ROOT, { reply_count: 3 }),
        m("101.000000", { reactions: [{ name: "eyes" }], attachments: [{ id: 1 }] }),
        m("102.000000", { client_msg_id: "abc" }),
      ],
      complete: true,
      trackEdits: true,
    });
    expect(changes).toEqual({ added: [], edited: [], deleted: [] });
  });

  test("root edits and tombstones count as edits", () => {
    const { changes } = diffThread(base(), {
      messages: [
        m(ROOT, { subtype: "tombstone", text: "This message was deleted." }),
        m("101.000000"),
        m("102.000000", { client_msg_id: "abc" }),
      ],
      complete: true,
      trackEdits: true,
    });
    expect(changes.edited.map((e) => e.msg.ts)).toEqual([ROOT]);
  });

  test("incremental read keeps unseen messages and never reports deletes", () => {
    const { next, changes } = diffThread(base(), {
      messages: [m(ROOT), m("103.000000")],
      complete: false,
      trackEdits: true,
    });
    expect(changes.added.map((x) => x.ts)).toEqual(["103.000000"]);
    expect(changes.deleted).toEqual([]);
    expect(Object.keys(next.messages)).toHaveLength(4);
  });

  test("with edits off, changed text is ignored", () => {
    const { changes } = diffThread(base(), {
      messages: [m("101.000000", { text: "changed" })],
      complete: false,
      trackEdits: false,
    });
    expect(changes.edited).toEqual([]);
  });

  test("messages after a --since cursor that are missing from the snapshot are new", () => {
    const snap = baselineSnapshot(emptySnapshot({ channelId: "C1", threadTs: ROOT }), [m(ROOT)]);
    snap.cursor = "100.500000";
    const { changes } = diffThread(snap, {
      messages: [m(ROOT), m("100.400000"), m("101.000000")],
      complete: true,
      trackEdits: true,
    });
    expect(changes.added.map((x) => x.ts)).toEqual(["101.000000"]);
  });
});

describe("withoutOwnApiChanges", () => {
  test("drops own API posts, edits and deletes; keeps own typed ones and others", () => {
    const changes = {
      added: [m("1.0", { user: "ME" }), m("2.0", { user: "ME", client_msg_id: "x" }), m("3.0")],
      edited: [{ msg: m("4.0", { user: "ME" }), before: "" }],
      deleted: [
        { ts: "5.0", user: "ME", api: true, before: "" },
        { ts: "6.0", user: "ME", api: false, before: "" },
      ],
    };
    const kept = withoutOwnApiChanges(changes, "ME");
    expect(kept.added.map((x) => x.ts)).toEqual(["2.0", "3.0"]);
    expect(kept.edited).toEqual([]);
    expect(kept.deleted.map((d) => d.ts)).toEqual(["6.0"]);
  });
});

describe("mergeChanges", () => {
  test("an edit to an unreported reply folds into the new entry; add+delete cancels", () => {
    const first = { added: [m("1.0"), m("2.0")], edited: [], deleted: [] };
    const later = {
      added: [m("3.0")],
      edited: [{ msg: m("1.0", { text: "v2" }), before: "text 1.0" }],
      deleted: [{ ts: "2.0", api: true, before: "text 2.0" }],
    };
    const merged = mergeChanges(first, later);
    expect(merged.added.map((x) => [x.ts, x.text])).toEqual([
      ["1.0", "v2"],
      ["3.0", "text 3.0"],
    ]);
    expect(merged.edited).toEqual([]);
    expect(merged.deleted).toEqual([]);
  });

  test("repeated edits keep the original before text", () => {
    const first = {
      added: [],
      edited: [{ msg: m("1.0", { text: "v2" }), before: "v1" }],
      deleted: [],
    };
    const later = {
      added: [],
      edited: [{ msg: m("1.0", { text: "v3" }), before: "v2" }],
      deleted: [],
    };
    const merged = mergeChanges(first, later);
    expect(merged.edited.map((e) => [e.msg.text, e.before])).toEqual([["v3", "v1"]]);
  });
});
