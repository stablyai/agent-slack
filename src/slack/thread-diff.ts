import { createHash } from "node:crypto";
import type { SlackMessageSummary } from "./messages.ts";

/** What a watch remembers about one message between polls. */
export type TrackedMessage = {
  fp: string;
  user?: string;
  // No client_msg_id: posted through the API (e.g. agent-slack), not typed in a client.
  api: boolean;
  text: string;
};

export type ThreadSnapshot = {
  channel_id: string;
  thread_ts: string;
  // Newest message ts seen; replies after it are new.
  cursor: string;
  reply_count?: number;
  messages: Record<string, TrackedMessage>;
  // Whole-conversation watch (e.g. a DM): `messages` holds the newest top-level
  // messages, `thread_ts` is "", and `latest_replies` maps thread roots to their newest reply.
  kind?: "channel";
  latest_replies?: Record<string, string>;
};

/** How many recent top-level messages a conversation watch keeps for edit and delete tracking. */
export const CHANNEL_WINDOW = 20;

export type ThreadChanges = {
  added: SlackMessageSummary[];
  edited: { msg: SlackMessageSummary; before: string }[];
  deleted: { ts: string; user?: string; api: boolean; before: string }[];
};

const MAX_TRACKED_TEXT = 2000;

/** Compares Slack "seconds.micros" timestamps exactly (floats lose the micros). */
export function compareSlackTs(a: string, b: string): number {
  const [aSec = "0", aFrac = ""] = a.split(".");
  const [bSec = "0", bFrac = ""] = b.split(".");
  const secDiff = BigInt(aSec) - BigInt(bSec);
  if (secDiff !== 0n) {
    return secDiff > 0n ? 1 : -1;
  }
  const width = Math.max(aFrac.length, bFrac.length);
  const fa = aFrac.padEnd(width, "0");
  const fb = bFrac.padEnd(width, "0");
  return fa === fb ? 0 : fa > fb ? 1 : -1;
}

/** Changes when the text, edit stamp, subtype (e.g. tombstone) or file set changes; ignores unfurls and reactions. */
export function fingerprint(m: SlackMessageSummary): string {
  const files = (m.files ?? []).map((f) => f.id).join(",");
  return createHash("sha1")
    .update([m.edited_ts ?? "", m.subtype ?? "", m.text, files].join("\u0000"))
    .digest("base64url")
    .slice(0, 16);
}

function track(m: SlackMessageSummary): TrackedMessage {
  return {
    fp: fingerprint(m),
    user: m.user,
    api: !m.client_msg_id,
    text: m.text.slice(0, MAX_TRACKED_TEXT),
  };
}

export function emptySnapshot(input: {
  channelId: string;
  threadTs: string;
  cursor?: string;
}): ThreadSnapshot {
  return {
    channel_id: input.channelId,
    thread_ts: input.threadTs,
    cursor: input.cursor ?? input.threadTs,
    messages: {},
  };
}

/** Records every message as known without reporting anything. */
export function baselineSnapshot(
  snapshot: ThreadSnapshot,
  messages: SlackMessageSummary[],
): ThreadSnapshot {
  return diffThread(snapshot, { messages, complete: true, trackEdits: true, baseline: true }).next;
}

/**
 * Diffs one poll against the previous snapshot. `complete` means the poll
 * returned the whole thread, so missing messages count as deleted; an
 * incremental poll (`oldest` = cursor) can only add.
 */
export function diffThread(
  prev: ThreadSnapshot,
  opts: {
    messages: SlackMessageSummary[];
    complete: boolean;
    trackEdits: boolean;
    baseline?: boolean;
  },
): { next: ThreadSnapshot; changes: ThreadChanges } {
  const changes: ThreadChanges = { added: [], edited: [], deleted: [] };
  const nextMessages: Record<string, TrackedMessage> = opts.complete ? {} : { ...prev.messages };
  let { cursor, reply_count: replyCount } = prev;
  const seen = new Set<string>();

  const ordered = opts.messages.filter((m) => m.ts).sort((a, b) => compareSlackTs(a.ts, b.ts));
  for (const m of ordered) {
    seen.add(m.ts);
    const old = prev.messages[m.ts];
    const tracked = track(m);
    if (m.ts === prev.thread_ts && m.reply_count !== undefined) {
      replyCount = m.reply_count;
    }
    if (!opts.baseline) {
      if (!old && m.ts !== prev.thread_ts && compareSlackTs(m.ts, prev.cursor) > 0) {
        changes.added.push(m);
      } else if (old && opts.trackEdits && old.fp !== tracked.fp) {
        changes.edited.push({ msg: m, before: old.text });
      }
    }
    nextMessages[m.ts] = tracked;
    if (compareSlackTs(m.ts, cursor) > 0) {
      cursor = m.ts;
    }
  }

  if (opts.complete && opts.trackEdits && !opts.baseline) {
    for (const [ts, old] of Object.entries(prev.messages)) {
      if (!seen.has(ts)) {
        changes.deleted.push({ ts, user: old.user, api: old.api, before: old.text });
      }
    }
  }

  return {
    next: { ...prev, cursor, reply_count: replyCount, messages: nextMessages },
    changes,
  };
}

export function isThreadRoot(m: SlackMessageSummary): boolean {
  return !m.thread_ts || m.thread_ts === m.ts;
}

/**
 * Diffs a conversation watch. On a sweep (`complete`), `messages` must be every
 * top-level message at or after the oldest tracked one, so a tracked message that
 * is missing was deleted. Keeps the newest `window` messages, and returns the
 * thread roots whose `latest_reply` moved: the caller fetches replies after `after`.
 */
export function diffChannel(
  prev: ThreadSnapshot,
  opts: {
    messages: SlackMessageSummary[];
    trackEdits: boolean;
    window: number;
    // false: `messages` are only those after the cursor, so nothing counts as deleted.
    complete?: boolean;
    baseline?: boolean;
  },
): {
  next: ThreadSnapshot;
  changes: ThreadChanges;
  replyChecks: { root: string; after: string }[];
} {
  const { next, changes } = diffThread(prev, {
    messages: opts.messages,
    complete: opts.complete ?? true,
    trackEdits: opts.trackEdits,
    baseline: opts.baseline,
  });
  const keep = Object.keys(next.messages).sort(compareSlackTs).slice(-opts.window);
  next.messages = Object.fromEntries(keep.map((ts) => [ts, next.messages[ts]!]));
  // An incremental read only sees new roots, so known roots keep their entries.
  const latest: Record<string, string> = {};
  if (opts.complete === false) {
    for (const [ts, reply] of Object.entries(prev.latest_replies ?? {})) {
      if (next.messages[ts]) {
        latest[ts] = reply;
      }
    }
  }
  const replyChecks: { root: string; after: string }[] = [];
  for (const m of opts.messages) {
    if (!m.latest_reply || !isThreadRoot(m) || !next.messages[m.ts]) {
      continue;
    }
    latest[m.ts] = m.latest_reply;
    const after = prev.latest_replies?.[m.ts] ?? m.ts;
    if (!opts.baseline && compareSlackTs(m.latest_reply, after) > 0) {
      replyChecks.push({ root: m.ts, after });
    }
  }
  next.kind = "channel";
  next.latest_replies = latest;
  return { next, changes, replyChecks };
}

export function hasChanges(c: ThreadChanges): boolean {
  return c.added.length + c.edited.length + c.deleted.length > 0;
}

/** Drops changes made by `userId` through the API, so an agent is not woken by its own posts and edits. */
export function withoutOwnApiChanges(c: ThreadChanges, userId: string | undefined): ThreadChanges {
  if (!userId) {
    return c;
  }
  const own = (m: SlackMessageSummary) => m.user === userId && !m.client_msg_id;
  return {
    added: c.added.filter((m) => !own(m)),
    edited: c.edited.filter((e) => !own(e.msg)),
    deleted: c.deleted.filter((d) => !(d.user === userId && d.api)),
  };
}

/** Folds a later poll's changes into a pending batch; the latest version of a message wins. */
export function mergeChanges(into: ThreadChanges, more: ThreadChanges): ThreadChanges {
  const deletedTs = new Set(more.deleted.map((d) => d.ts));
  const addedByTs = new Map(into.added.map((m) => [m.ts, m]));
  const edited = [...into.edited];
  for (const e of more.edited) {
    if (addedByTs.has(e.msg.ts)) {
      // Still unreported: report the edited version as new.
      addedByTs.set(e.msg.ts, e.msg);
      continue;
    }
    const i = edited.findIndex((x) => x.msg.ts === e.msg.ts);
    if (i >= 0) {
      edited[i] = { msg: e.msg, before: edited[i]!.before };
    } else {
      edited.push(e);
    }
  }
  const added = [...addedByTs.values(), ...more.added].filter((m) => !deletedTs.has(m.ts));
  const deleted = [
    ...into.deleted,
    // Added and deleted inside one batch: nothing to report.
    ...more.deleted.filter((d) => !into.added.some((m) => m.ts === d.ts)),
  ];
  return {
    added,
    edited: edited.filter((e) => !deletedTs.has(e.msg.ts)),
    deleted,
  };
}
