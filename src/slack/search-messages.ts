import type { SlackApiClient, SlackAuth } from "./client.ts";
import type { CompactSlackMessage, SlackFileSummary, SlackMessageSummary } from "./messages.ts";
import { fetchMessage, toCompactMessage } from "./messages.ts";
import { resolveChannelId } from "./channels.ts";
import { ensureDownloadsDir } from "../lib/tmp-paths.ts";
import { downloadSlackFile } from "./files.ts";
import { renderSlackMessageContent } from "./render.ts";
import { parseSlackMessageUrl } from "./url.ts";
import { inferExt } from "./search-file-ext.ts";
import { dateToUnixSeconds, resolveUserId } from "./search-query.ts";
import { asArray, getNumber, getString, isRecord } from "./search-guards.ts";
import { slackMrkdwnToMarkdown } from "./mrkdwn.ts";

export type ContentType = "any" | "text" | "image" | "snippet" | "file";

export async function searchMessagesViaSearchApi(
  client: SlackApiClient,
  input: {
    auth: SlackAuth;
    workspace_url?: string;
    slack_query: string;
    limit: number;
    maxContentChars: number;
    contentType: ContentType;
    download: boolean;
    rawMatches: Record<string, unknown>[];
  },
): Promise<Omit<CompactSlackMessage, "channel_id" | "thread_ts">[]> {
  const matches = input.rawMatches;
  if (matches.length === 0) {
    return [];
  }

  const messageRefs: {
    channel_id: string;
    message_ts: string;
    permalink?: string;
  }[] = [];
  for (const m of matches) {
    const ts = getString(m.ts)?.trim() ?? "";
    if (!ts) {
      continue;
    }
    const channelValue = isRecord(m.channel) ? m.channel : null;
    const channelId =
      channelValue && getString(channelValue.id)
        ? getString(channelValue.id)!
        : channelValue && getString(channelValue.name)
          ? await resolveChannelId(client, `#${getString(channelValue.name)}`)
          : "";
    if (!channelId) {
      continue;
    }
    messageRefs.push({
      channel_id: channelId,
      message_ts: ts,
      permalink: getString(m.permalink),
    });
    if (messageRefs.length >= input.limit) {
      break;
    }
  }

  const downloadedPaths: Record<string, string> = {};
  const downloadsDir = input.download ? await ensureDownloadsDir() : null;
  const out: Omit<CompactSlackMessage, "channel_id" | "thread_ts">[] = [];

  for (const ref of messageRefs) {
    let full: SlackMessageSummary | null = null;
    try {
      const parsed =
        ref.permalink && typeof ref.permalink === "string"
          ? (() => {
              try {
                return parseSlackMessageUrl(ref.permalink);
              } catch {
                return null;
              }
            })()
          : null;

      full = await fetchMessage(client, {
        ref: {
          workspace_url: parsed?.workspace_url ?? input.workspace_url ?? "",
          channel_id: ref.channel_id,
          message_ts: ref.message_ts,
          thread_ts_hint: parsed?.thread_ts_hint,
          raw: parsed?.raw ?? ref.permalink ?? `${ref.channel_id}:${ref.message_ts}`,
        },
      });
    } catch {
      continue;
    }

    if (downloadsDir) {
      await downloadFilesForMessage({
        auth: input.auth,
        downloadsDir,
        message: full,
        downloadedPaths,
      });
    }

    const compact = toCompactMessage(full, {
      maxBodyChars: input.maxContentChars,
      downloadedPaths,
    });
    if (!passesContentTypeFilter(compact, input.contentType)) {
      continue;
    }
    out.push(stripThreadListFields(compact));
    if (out.length >= input.limit) {
      break;
    }
  }

  return out;
}

export async function searchMessagesInChannelsFallback(
  client: SlackApiClient,
  input: {
    auth: SlackAuth;
    query: string;
    channels: string[];
    user?: string;
    after?: string;
    before?: string;
    limit: number;
    maxContentChars: number;
    contentType: ContentType;
    download: boolean;
  },
): Promise<Omit<CompactSlackMessage, "channel_id" | "thread_ts">[]> {
  const channelIds = await Promise.all(input.channels.map((c) => resolveChannelId(client, c)));
  const queryLower = input.query.trim().toLowerCase();

  const userId = input.user ? await resolveUserId(client, input.user) : undefined;

  const afterSec = input.after ? dateToUnixSeconds(input.after, "start") : null;
  const beforeSec = input.before ? dateToUnixSeconds(input.before, "end") : null;

  const downloadsDir = input.download ? await ensureDownloadsDir() : null;
  const downloadedPaths: Record<string, string> = {};

  const results: Omit<CompactSlackMessage, "channel_id" | "thread_ts">[] = [];

  for (const channelId of channelIds) {
    let cursorLatest: string | undefined;
    for (;;) {
      const resp = await client.api("conversations.history", {
        channel: channelId,
        limit: 200,
        latest: cursorLatest,
      });
      const messages = isRecord(resp) ? asArray(resp.messages).filter(isRecord) : [];
      if (messages.length === 0) {
        break;
      }

      for (const m of messages) {
        const summary = messageSummaryFromApiMessage(channelId, m);

        const tsNum = Number.parseFloat(summary.ts);
        if (Number.isFinite(tsNum)) {
          if (beforeSec !== null && tsNum > beforeSec) {
            continue;
          }
          if (afterSec !== null && tsNum < afterSec) {
            cursorLatest = undefined;
            break;
          }
        }

        if (userId && summary.user !== userId) {
          continue;
        }

        const content = renderSlackMessageContent(summary);
        if (queryLower && !content.toLowerCase().includes(queryLower)) {
          continue;
        }

        if (downloadsDir) {
          await downloadFilesForMessage({
            auth: input.auth,
            downloadsDir,
            message: summary,
            downloadedPaths,
          });
        }

        const compact = toCompactMessage(summary, {
          maxBodyChars: input.maxContentChars,
          downloadedPaths,
        });
        if (!passesContentTypeFilter(compact, input.contentType)) {
          continue;
        }

        results.push(stripThreadListFields(compact));
        if (results.length >= input.limit) {
          return results;
        }
      }

      if (!cursorLatest) {
        break;
      }

      const last = messages.at(-1);
      cursorLatest = last ? getString(last.ts) : undefined;
      if (!cursorLatest) {
        break;
      }
    }
  }

  return results;
}

function passesContentTypeFilter(m: CompactSlackMessage, contentType: ContentType): boolean {
  if (contentType === "any") {
    return true;
  }
  const hasFiles = Boolean(m.files && m.files.length > 0);
  if (contentType === "text") {
    return !hasFiles;
  }
  if (!hasFiles) {
    return false;
  }

  if (contentType === "file") {
    return true;
  }
  if (contentType === "snippet") {
    return (m.files ?? []).some((f) => f.mode === "snippet");
  }
  if (contentType === "image") {
    return (m.files ?? []).some((f) => String(f.mimetype ?? "").startsWith("image/"));
  }
  return true;
}

function stripThreadListFields(
  m: CompactSlackMessage,
): Omit<CompactSlackMessage, "channel_id" | "thread_ts"> {
  const { channel_id: _channelId, thread_ts: _threadTs, ...rest } = m;
  return rest;
}

async function downloadFilesForMessage(input: {
  auth: SlackAuth;
  downloadsDir: string;
  message: SlackMessageSummary;
  downloadedPaths: Record<string, string>;
}): Promise<void> {
  for (const f of input.message.files ?? []) {
    if (input.downloadedPaths[f.id]) {
      continue;
    }
    const url = f.url_private_download || f.url_private;
    if (!url) {
      continue;
    }
    const ext = inferExt(f);
    const path = await downloadSlackFile({
      auth: input.auth,
      url,
      destDir: input.downloadsDir,
      preferredName: `${f.id}${ext ? `.${ext}` : ""}`,
    });
    input.downloadedPaths[f.id] = path;
  }
}

function messageSummaryFromApiMessage(
  channelId: string,
  msg: Record<string, unknown>,
): SlackMessageSummary {
  const text = getString(msg.text) ?? "";
  const files = asArray(msg.files)
    .map((f) => toSlackFileSummary(f))
    .filter((f): f is SlackFileSummary => f !== null);

  return {
    channel_id: channelId,
    ts: getString(msg.ts) ?? "",
    thread_ts: getString(msg.thread_ts),
    reply_count: getNumber(msg.reply_count),
    user: getString(msg.user),
    bot_id: getString(msg.bot_id),
    text,
    markdown: slackMrkdwnToMarkdown(text),
    blocks: Array.isArray(msg.blocks) ? (msg.blocks as unknown[]) : undefined,
    attachments: Array.isArray(msg.attachments) ? (msg.attachments as unknown[]) : undefined,
    files: files.length > 0 ? files : undefined,
    reactions: Array.isArray(msg.reactions) ? (msg.reactions as unknown[]) : undefined,
  };
}

function toSlackFileSummary(value: unknown): SlackFileSummary | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = getString(value.id);
  if (!id) {
    return null;
  }
  return {
    id,
    name: getString(value.name),
    title: getString(value.title),
    mimetype: getString(value.mimetype),
    filetype: getString(value.filetype),
    mode: getString(value.mode),
    permalink: getString(value.permalink),
    url_private: getString(value.url_private),
    url_private_download: getString(value.url_private_download),
    size: getNumber(value.size),
  };
}
