import type { SlackMessageRef } from "./url.ts";
import { SlackApiClient } from "./client.ts";
import { slackMrkdwnToMarkdown } from "./mrkdwn.ts";
import { renderSlackMessageContent } from "./render.ts";

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
  blocks?: any[];
  attachments?: any[];
  files?: SlackFileSummary[];
  reactions?: any[];
};

export type CompactSlackMessage = {
  channel_id: string;
  ts: string;
  thread_ts?: string;
  author?: { user_id?: string; bot_id?: string };
  content?: string;
  files?: Array<{
    mimetype?: string;
    mode?: string;
    path: string;
  }>;
  reactions?: any[];
};

export function toCompactMessage(
  msg: SlackMessageSummary,
  options?: { maxSnippetChars?: number; maxBodyChars?: number },
  downloadedPaths?: Record<string, string>,
): CompactSlackMessage {
  const maxSnippetChars = options?.maxSnippetChars ?? 4000;
  const maxBodyChars = options?.maxBodyChars ?? 8000;

  const rendered = renderSlackMessageContent(msg as any);
  const content =
    maxBodyChars >= 0 && rendered.length > maxBodyChars
      ? rendered.slice(0, maxBodyChars) + "\n…"
      : rendered;

  const files =
    msg.files
      ?.map((f) => {
        const path = downloadedPaths?.[f.id];
        if (!path) return null;
        return {
          mimetype: f.mimetype,
          mode: f.mode,
          path,
        };
      })
      .filter(Boolean) ?? undefined;

  return {
    channel_id: msg.channel_id,
    ts: msg.ts,
    thread_ts:
      msg.thread_ts ?? ((msg.reply_count ?? 0) > 0 ? msg.ts : undefined),
    author:
      msg.user || msg.bot_id
        ? { user_id: msg.user, bot_id: msg.bot_id }
        : undefined,
    content: content ? content : undefined,
    files: files && files.length > 0 ? (files as any) : undefined,
    reactions: msg.reactions,
  };
}

export async function fetchMessage(
  client: SlackApiClient,
  ref: SlackMessageRef,
): Promise<SlackMessageSummary> {
  const history = await client.api("conversations.history", {
    channel: ref.channel_id,
    latest: ref.message_ts,
    inclusive: true,
    limit: 5,
  });
  const historyMessages = (history.messages ?? []) as any[];
  let msg = historyMessages.find((m) => m?.ts === ref.message_ts);

  // Thread replies are not guaranteed to appear in channel history. If the URL
  // includes ?thread_ts=..., scan the thread directly.
  if (!msg && ref.thread_ts_hint) {
    msg = await findMessageInThread(
      client,
      ref.channel_id,
      ref.thread_ts_hint,
      ref.message_ts,
    );
  }

  // Fallback: if the message_ts is actually the thread root, replies can still
  // be fetched via conversations.replies even if history is missing it.
  if (!msg) {
    try {
      const rootResp = await client.api("conversations.replies", {
        channel: ref.channel_id,
        ts: ref.message_ts,
        limit: 1,
      });
      const root = (rootResp.messages ?? [])[0] as any;
      if (root?.ts === ref.message_ts) msg = root;
    } catch {
      // ignore
    }
  }

  if (!msg) throw new Error("Message not found (no access or wrong URL)");

  const files: SlackFileSummary[] | undefined = Array.isArray(msg.files)
    ? msg.files.map((f: any) => ({
        id: f.id,
        name: f.name,
        title: f.title,
        mimetype: f.mimetype,
        filetype: f.filetype,
        mode: f.mode,
        permalink: f.permalink,
        url_private: f.url_private,
        url_private_download: f.url_private_download,
        size: f.size,
      }))
    : undefined;

  const enrichedFiles = files ? await enrichFiles(client, files) : undefined;

  const text = msg.text ?? "";
  return {
    channel_id: ref.channel_id,
    ts: msg.ts,
    thread_ts: msg.thread_ts,
    reply_count: msg.reply_count,
    user: msg.user,
    bot_id: msg.bot_id,
    text,
    markdown: slackMrkdwnToMarkdown(text),
    blocks: msg.blocks,
    attachments: msg.attachments,
    files: enrichedFiles,
    reactions: msg.reactions,
  };
}

async function findMessageInThread(
  client: SlackApiClient,
  channelId: string,
  threadTs: string,
  targetTs: string,
): Promise<any | null> {
  let cursor: string | undefined;
  for (;;) {
    const resp = await client.api("conversations.replies", {
      channel: channelId,
      ts: threadTs,
      limit: 200,
      cursor,
    });
    const messages = (resp.messages ?? []) as any[];
    const found = messages.find((m) => m?.ts === targetTs);
    if (found) return found;
    const next = resp.response_metadata?.next_cursor;
    if (!next) break;
    cursor = next;
  }
  return null;
}

export async function fetchThread(
  client: SlackApiClient,
  channelId: string,
  threadTs: string,
): Promise<SlackMessageSummary[]> {
  const out: SlackMessageSummary[] = [];
  let cursor: string | undefined;

  for (;;) {
    const resp = await client.api("conversations.replies", {
      channel: channelId,
      ts: threadTs,
      limit: 200,
      cursor,
    });
    const messages = (resp.messages ?? []) as any[];
    for (const m of messages) {
      const files: SlackFileSummary[] | undefined = Array.isArray(m.files)
        ? m.files.map((f: any) => ({
            id: f.id,
            name: f.name,
            title: f.title,
            mimetype: f.mimetype,
            filetype: f.filetype,
            mode: f.mode,
            permalink: f.permalink,
            url_private: f.url_private,
            url_private_download: f.url_private_download,
            size: f.size,
          }))
        : undefined;
      const enrichedFiles = files
        ? await enrichFiles(client, files)
        : undefined;

      const text = m.text ?? "";
      out.push({
        channel_id: channelId,
        ts: m.ts,
        thread_ts: m.thread_ts,
        reply_count: m.reply_count,
        user: m.user,
        bot_id: m.bot_id,
        text,
        markdown: slackMrkdwnToMarkdown(text),
        blocks: m.blocks,
        attachments: m.attachments,
        files: enrichedFiles,
        reactions: m.reactions,
      });
    }
    const next = resp.response_metadata?.next_cursor;
    if (!next) break;
    cursor = next;
  }

  // Slack returns newest-first for some methods; normalize to chronological.
  out.sort((a, b) => Number.parseFloat(a.ts) - Number.parseFloat(b.ts));
  return out;
}

async function enrichFiles(
  client: SlackApiClient,
  files: SlackFileSummary[],
): Promise<SlackFileSummary[]> {
  const out: SlackFileSummary[] = [];
  for (const f of files) {
    if (f.mode === "snippet" || !f.url_private_download) {
      try {
        const info = await client.api("files.info", { file: f.id });
        const file = info.file;
        out.push({
          ...f,
          name: f.name ?? file?.name,
          title: f.title ?? file?.title,
          mimetype: f.mimetype ?? file?.mimetype,
          filetype: f.filetype ?? file?.filetype,
          mode: f.mode ?? file?.mode,
          permalink: f.permalink ?? file?.permalink,
          url_private: f.url_private ?? file?.url_private,
          url_private_download:
            f.url_private_download ?? file?.url_private_download,
          snippet: {
            content: file?.content,
            language: file?.filetype,
          },
        });
        continue;
      } catch {
        // ignore and fall back to summary
      }
    }
    out.push(f);
  }
  return out;
}
