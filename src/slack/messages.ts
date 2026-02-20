import type { SlackMessageRef } from "./url.ts";
import type { SlackApiClient } from "./client.ts";
import { slackMrkdwnToMarkdown } from "./mrkdwn.ts";
import { renderSlackMessageContent } from "./render.ts";
import { asArray, getNumber, getString, isRecord } from "../lib/object-type-guards.ts";
import { enrichFiles, toSlackFileSummary } from "./message-api-parsing.ts";

export type SlackFileSummary = {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  mode?: string;
  permalink?: string;
  url_private?: string;
  url_private_download?: string;
  size?: number;
  snippet?: {
    content?: string;
    language?: string;
  };
};

export type SlackMessageSummary = {
  channel_id: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
  user?: string;
  bot_id?: string;
  text: string;
  markdown: string;
  blocks?: unknown[];
  attachments?: unknown[];
  files?: SlackFileSummary[];
  reactions?: unknown[];
};

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
    has_more_replies: true;
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

function compactReactions(
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

function extractForwardedThreads(attachments: unknown[] | undefined):
  | {
      url: string;
      thread_ts: string;
      channel_id?: string;
      has_more_replies: true;
    }[]
  | undefined {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return undefined;
  }
  const out: {
    url: string;
    thread_ts: string;
    channel_id?: string;
    has_more_replies: true;
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
    const key = `${fromUrl}::${threadTs}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({
      url: fromUrl,
      thread_ts: threadTs,
      channel_id: channelId || undefined,
      has_more_replies: true,
    });
  }
  return out.length ? out : undefined;
}

export async function fetchMessage(
  client: SlackApiClient,
  input: { ref: SlackMessageRef; includeReactions?: boolean },
): Promise<SlackMessageSummary> {
  const history = await client.api("conversations.history", {
    channel: input.ref.channel_id,
    latest: input.ref.message_ts,
    inclusive: true,
    limit: 5,
    include_all_metadata: input.includeReactions ? true : undefined,
  });
  const historyMessages = asArray(history.messages);
  let msg = historyMessages.find(
    (m): m is Record<string, unknown> => isRecord(m) && getString(m.ts) === input.ref.message_ts,
  );

  // Thread replies are not guaranteed to appear in channel history. If the URL
  // includes ?thread_ts=..., scan the thread directly.
  if (!msg && input.ref.thread_ts_hint) {
    msg = await findMessageInThread(client, {
      channelId: input.ref.channel_id,
      threadTs: input.ref.thread_ts_hint,
      targetTs: input.ref.message_ts,
      includeReactions: input.includeReactions,
    });
  }

  // Fallback: if the message_ts is actually the thread root, replies can still
  // be fetched via conversations.replies even if history is missing it.
  if (!msg) {
    try {
      const rootResp = await client.api("conversations.replies", {
        channel: input.ref.channel_id,
        ts: input.ref.message_ts,
        limit: 1,
        include_all_metadata: input.includeReactions ? true : undefined,
      });
      const [root] = asArray(rootResp.messages);
      if (isRecord(root) && getString(root.ts) === input.ref.message_ts) {
        msg = root;
      }
    } catch {
      // ignore
    }
  }

  if (!msg) {
    throw new Error("Message not found (no access or wrong URL)");
  }

  const files = asArray(msg.files)
    .map((f) => toSlackFileSummary(f))
    .filter((f): f is SlackFileSummary => f !== null);
  const enrichedFiles = files.length > 0 ? await enrichFiles(client, files) : undefined;

  const text = getString(msg.text) ?? "";
  const ts = getString(msg.ts) ?? input.ref.message_ts;
  const blocks = Array.isArray(msg.blocks) ? (msg.blocks as unknown[]) : undefined;
  const attachments = Array.isArray(msg.attachments) ? (msg.attachments as unknown[]) : undefined;
  const reactions = Array.isArray(msg.reactions) ? (msg.reactions as unknown[]) : undefined;
  return {
    channel_id: input.ref.channel_id,
    ts,
    thread_ts: getString(msg.thread_ts),
    reply_count: getNumber(msg.reply_count),
    user: getString(msg.user),
    bot_id: getString(msg.bot_id),
    text,
    markdown: slackMrkdwnToMarkdown(text),
    blocks,
    attachments,
    files: enrichedFiles,
    reactions,
  };
}

async function findMessageInThread(
  client: SlackApiClient,
  input: {
    channelId: string;
    threadTs: string;
    targetTs: string;
    includeReactions?: boolean;
  },
): Promise<Record<string, unknown> | undefined> {
  let cursor: string | undefined;
  for (;;) {
    const resp = await client.api("conversations.replies", {
      channel: input.channelId,
      ts: input.threadTs,
      limit: 200,
      cursor,
      include_all_metadata: input.includeReactions ? true : undefined,
    });
    const messages = asArray(resp.messages);
    const found = messages.find(
      (m): m is Record<string, unknown> => isRecord(m) && getString(m.ts) === input.targetTs,
    );
    if (found) {
      return found;
    }
    const meta = isRecord(resp.response_metadata) ? resp.response_metadata : null;
    const next = meta ? getString(meta.next_cursor) : undefined;
    if (!next) {
      break;
    }
    cursor = next;
  }
  return undefined;
}

export async function fetchChannelHistory(
  client: SlackApiClient,
  input: {
    channelId: string;
    limit?: number;
    latest?: string;
    oldest?: string;
    includeReactions?: boolean;
  },
): Promise<SlackMessageSummary[]> {
  const raw = input.limit ?? 25;
  const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 200) : 25;
  const out: SlackMessageSummary[] = [];

  const resp = await client.api("conversations.history", {
    channel: input.channelId,
    limit,
    latest: input.latest,
    oldest: input.oldest,
    include_all_metadata: input.includeReactions ? true : undefined,
  });
  const messages = asArray(resp.messages);
  for (const m of messages) {
    if (!isRecord(m)) {
      continue;
    }
    const files = asArray(m.files)
      .map((f) => toSlackFileSummary(f))
      .filter((f): f is SlackFileSummary => f !== null);
    const enrichedFiles = files.length > 0 ? await enrichFiles(client, files) : undefined;

    const text = getString(m.text) ?? "";
    out.push({
      channel_id: input.channelId,
      ts: getString(m.ts) ?? "",
      thread_ts: getString(m.thread_ts),
      reply_count: getNumber(m.reply_count),
      user: getString(m.user),
      bot_id: getString(m.bot_id),
      text,
      markdown: slackMrkdwnToMarkdown(text),
      blocks: Array.isArray(m.blocks) ? (m.blocks as unknown[]) : undefined,
      attachments: Array.isArray(m.attachments) ? (m.attachments as unknown[]) : undefined,
      files: enrichedFiles,
      reactions: Array.isArray(m.reactions) ? (m.reactions as unknown[]) : undefined,
    });
  }

  // conversations.history returns newest-first; normalize to chronological.
  out.sort((a, b) => Number.parseFloat(a.ts) - Number.parseFloat(b.ts));
  return out;
}

export async function fetchThread(
  client: SlackApiClient,
  input: { channelId: string; threadTs: string; includeReactions?: boolean },
): Promise<SlackMessageSummary[]> {
  const out: SlackMessageSummary[] = [];
  let cursor: string | undefined;

  for (;;) {
    const resp = await client.api("conversations.replies", {
      channel: input.channelId,
      ts: input.threadTs,
      limit: 200,
      cursor,
      include_all_metadata: input.includeReactions ? true : undefined,
    });
    const messages = asArray(resp.messages);
    for (const m of messages) {
      if (!isRecord(m)) {
        continue;
      }
      const files = asArray(m.files)
        .map((f) => toSlackFileSummary(f))
        .filter((f): f is SlackFileSummary => f !== null);
      const enrichedFiles = files.length > 0 ? await enrichFiles(client, files) : undefined;

      const text = getString(m.text) ?? "";
      out.push({
        channel_id: input.channelId,
        ts: getString(m.ts) ?? "",
        thread_ts: getString(m.thread_ts),
        reply_count: getNumber(m.reply_count),
        user: getString(m.user),
        bot_id: getString(m.bot_id),
        text,
        markdown: slackMrkdwnToMarkdown(text),
        blocks: Array.isArray(m.blocks) ? (m.blocks as unknown[]) : undefined,
        attachments: Array.isArray(m.attachments) ? (m.attachments as unknown[]) : undefined,
        files: enrichedFiles,
        reactions: Array.isArray(m.reactions) ? (m.reactions as unknown[]) : undefined,
      });
    }
    const meta = isRecord(resp.response_metadata) ? resp.response_metadata : null;
    const next = meta ? getString(meta.next_cursor) : undefined;
    if (!next) {
      break;
    }
    cursor = next;
  }

  // Slack returns newest-first for some methods; normalize to chronological.
  out.sort((a, b) => Number.parseFloat(a.ts) - Number.parseFloat(b.ts));
  return out;
}
