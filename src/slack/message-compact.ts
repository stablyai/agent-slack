import type { SlackMessageSummary } from "./messages.ts";
import { renderSlackMessageContent } from "./render.ts";
import { getNumber, getString, isRecord } from "../lib/object-type-guards.ts";

export type CompactSlackMessage = {
  channel_id: string;
  ts: string;
  thread_ts?: string;
  author?: { user_id?: string; bot_id?: string };
  content?: string;
  files?: {
    mimetype?: string;
    mode?: string;
    path: string;
  }[];
  reactions?: {
    name: string;
    users: string[];
    count?: number;
  }[];
  forwarded_threads?: {
    url: string;
    thread_ts: string;
    channel_id?: string;
    reply_count?: number;
  }[];
};

export function toCompactMessage(
  msg: SlackMessageSummary,
  input?: {
    maxSnippetChars?: number;
    maxBodyChars?: number;
    includeReactions?: boolean;
    downloadedPaths?: Record<string, string>;
  },
): CompactSlackMessage {
  const maxBodyChars = input?.maxBodyChars ?? 8000;
  const includeReactions = input?.includeReactions ?? false;

  const rendered = renderSlackMessageContent(msg);
  const content =
    maxBodyChars >= 0 && rendered.length > maxBodyChars
      ? `${rendered.slice(0, maxBodyChars)}\n…`
      : rendered;

  const files = msg.files
    ?.map((f) => {
      const path = input?.downloadedPaths?.[f.id];
      if (!path) {
        return null;
      }
      return {
        mimetype: f.mimetype,
        mode: f.mode,
        path,
      };
    })
    .filter((f): f is NonNullable<typeof f> => Boolean(f));

  return {
    channel_id: msg.channel_id,
    ts: msg.ts,
    thread_ts: msg.thread_ts ?? ((msg.reply_count ?? 0) > 0 ? msg.ts : undefined),
    author: msg.user || msg.bot_id ? { user_id: msg.user, bot_id: msg.bot_id } : undefined,
    content: content ? content : undefined,
    files: files && files.length > 0 ? files : undefined,
    reactions: includeReactions ? compactReactions(msg.reactions) : undefined,
    forwarded_threads: extractForwardedThreads(msg.attachments),
  };
}

export function compactReactions(
  reactions: unknown[] | undefined,
): Array<{ name: string; users: string[]; count?: number }> | undefined {
  if (!Array.isArray(reactions) || reactions.length === 0) {
    return undefined;
  }
  const out: { name: string; users: string[]; count?: number }[] = [];
  for (const r of reactions) {
    if (!isRecord(r)) {
      continue;
    }
    const name = getString(r.name)?.trim() ?? "";
    if (!name) {
      continue;
    }
    const users = Array.isArray(r.users)
      ? r.users.map((u) => String(u)).filter((u) => /^U[A-Z0-9]{8,}$/.test(u))
      : [];
    const count = typeof r.count === "number" && r.count !== users.length ? r.count : undefined;
    out.push({ name, users, count });
  }
  return out.length ? out : undefined;
}

export function extractForwardedThreads(attachments: unknown[] | undefined):
  | {
      url: string;
      thread_ts: string;
      channel_id?: string;
      reply_count?: number;
    }[]
  | undefined {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return undefined;
  }
  const out: {
    url: string;
    thread_ts: string;
    channel_id?: string;
    reply_count?: number;
  }[] = [];
  const seen = new Set<string>();
  for (const attachment of attachments) {
    if (!isRecord(attachment)) {
      continue;
    }
    const fromUrl = getString(attachment.from_url)?.trim();
    if (!fromUrl) {
      continue;
    }
    let parsed: URL;
    try {
      parsed = new URL(fromUrl);
    } catch {
      continue;
    }
    const threadTs = parsed.searchParams.get("thread_ts")?.trim();
    if (!threadTs || !/^\d{6,}\.\d{6}$/.test(threadTs)) {
      continue;
    }
    const channelId = parsed.searchParams.get("cid")?.trim();
    const replyCount = getNumber(attachment.reply_count);
    const key = `${fromUrl}::${threadTs}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({
      url: fromUrl,
      thread_ts: threadTs,
      channel_id: channelId || undefined,
      reply_count: replyCount,
    });
  }
  return out.length ? out : undefined;
}
