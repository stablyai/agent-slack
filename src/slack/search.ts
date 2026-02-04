import type { SlackApiClient, SlackAuth } from "./client.ts";
import {
  toCompactMessage,
  type CompactSlackMessage,
  type SlackFileSummary,
  type SlackMessageSummary,
} from "./messages.ts";
import { resolveChannelId, normalizeChannelInput } from "./channels.ts";
import { downloadSlackFile } from "./files.ts";
import { ensureDownloadsDir } from "../lib/tmp-paths.ts";
import { slackMrkdwnToMarkdown } from "./mrkdwn.ts";
import { renderSlackMessageContent } from "./render.ts";

export type SearchKind = "messages" | "files" | "all";
export type ContentType = "any" | "text" | "image" | "snippet" | "file";

export type SearchOptions = {
  workspace_url?: string;
  query: string;
  kind: SearchKind;
  channels?: string[];
  user?: string; // @name, name, or U...
  after?: string; // YYYY-MM-DD
  before?: string; // YYYY-MM-DD
  content_type?: ContentType;
  limit?: number;
  max_content_chars?: number;
  download?: boolean;
};

export async function searchSlack(
  client: SlackApiClient,
  auth: SlackAuth,
  options: SearchOptions,
): Promise<{
  messages?: Array<Omit<CompactSlackMessage, "channel_id" | "thread_ts">>;
  files?: Array<{ title?: string; mimetype?: string; mode?: string; path: string }>;
}> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 200);
  const maxContentChars = options.max_content_chars ?? 4000;
  const contentType = options.content_type ?? "any";
  const download = options.download ?? true;
  if (!download && (options.kind === "files" || options.kind === "all")) {
    throw new Error(
      "File search requires downloads enabled (so agents get local file paths).",
    );
  }

  const query = await buildSlackSearchQuery(client, {
    query: options.query,
    channels: options.channels,
    user: options.user,
    after: options.after,
    before: options.before,
  });

  const out: any = {};

  if (options.kind === "messages" || options.kind === "all") {
    const messages = options.channels?.length
      ? await searchMessagesInChannelsFallback(client, auth, {
          query: options.query,
          channels: options.channels,
          user: options.user,
          after: options.after,
          before: options.before,
          limit,
          maxContentChars,
          contentType,
          download,
        })
      : await searchMessagesViaSearchApi(client, auth, {
          workspace_url: options.workspace_url,
          slack_query: query,
          limit,
          maxContentChars,
          contentType,
          download,
        });

    out.messages = messages;
  }

  if (options.kind === "files" || options.kind === "all") {
    // Prefer server-side search when available; fall back to files.list when channels are specified.
    const files = options.channels?.length
      ? await searchFilesInChannelsFallback(client, auth, {
          query: options.query,
          channels: options.channels,
          user: options.user,
          after: options.after,
          before: options.before,
          limit,
          contentType,
        })
      : await searchFilesViaSearchApi(client, auth, {
          slack_query: query,
          limit,
          contentType,
        });

    out.files = files;
  }

  return out;
}

async function buildSlackSearchQuery(
  client: SlackApiClient,
  input: {
    query: string;
    channels?: string[];
    user?: string;
    after?: string;
    before?: string;
  },
): Promise<string> {
  const parts: string[] = [];
  const base = input.query.trim();
  if (base) parts.push(base);

  if (input.after) parts.push(`after:${validateDate(input.after)}`);
  if (input.before) parts.push(`before:${validateDate(input.before)}`);

  if (input.user) {
    const token = await userTokenForSearch(client, input.user);
    if (token) parts.push(token);
  }

  if (input.channels && input.channels.length > 0) {
    for (const ch of input.channels) {
      const inToken = await channelTokenForSearch(client, ch);
      if (inToken) parts.push(inToken);
    }
  }

  return parts.join(" ");
}

function validateDate(s: string): string {
  const v = s.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new Error(`Invalid date: ${s} (expected YYYY-MM-DD)`);
  }
  return v;
}

async function userTokenForSearch(
  client: SlackApiClient,
  user: string,
): Promise<string | null> {
  const trimmed = user.trim();
  if (!trimmed) return null;

  // Accept @name or name
  if (trimmed.startsWith("@")) return `from:@${trimmed.slice(1)}`;
  if (/^U[A-Z0-9]{8,}$/.test(trimmed)) {
    try {
      const info = await client.api("users.info", { user: trimmed });
      const name = String(info.user?.name ?? "").trim();
      return name ? `from:@${name}` : null;
    } catch {
      return null;
    }
  }
  return `from:@${trimmed}`;
}

async function channelTokenForSearch(
  client: SlackApiClient,
  channel: string,
): Promise<string | null> {
  const normalized = normalizeChannelInput(channel);
  if (normalized.kind === "name") {
    const name = normalized.value.trim();
    if (!name) return null;
    return `in:#${name}`;
  }

  // Channel id -> name for use in search query.
  try {
    const info = await client.api("conversations.info", {
      channel: normalized.value,
    });
    const name = String(info.channel?.name ?? "").trim();
    if (name) return `in:#${name}`;
  } catch {
    // ignore
  }
  return null;
}

async function searchMessagesRaw(
  client: SlackApiClient,
  query: string,
  limit: number,
): Promise<any[]> {
  const pageSize = Math.min(limit, 100);
  const resp = await client.api("search.messages", {
    query,
    count: pageSize,
    page: 1,
    highlight: false,
    sort: "timestamp",
    sort_dir: "desc",
  });
  return (resp.messages?.matches ?? []) as any[];
}

async function searchFilesRaw(
  client: SlackApiClient,
  query: string,
  limit: number,
): Promise<any[]> {
  const pageSize = Math.min(limit, 100);
  const resp = await client.api("search.files", {
    query,
    count: pageSize,
    page: 1,
    highlight: false,
    sort: "timestamp",
    sort_dir: "desc",
  });
  return (resp.files?.matches ?? []) as any[];
}

function stripThreadListFields(
  m: CompactSlackMessage,
): Omit<CompactSlackMessage, "channel_id" | "thread_ts"> {
  const { channel_id: _channelId, thread_ts: _threadTs, ...rest } = m;
  return rest;
}

function inferExt(file: { mimetype?: string; filetype?: string; name?: string; title?: string }): string | null {
  const mt = (file.mimetype || "").toLowerCase();
  const ft = (file.filetype || "").toLowerCase();

  if (mt === "image/png" || ft === "png") return "png";
  if (mt === "image/jpeg" || mt === "image/jpg" || ft === "jpg" || ft === "jpeg")
    return "jpg";
  if (mt === "image/webp" || ft === "webp") return "webp";
  if (mt === "image/gif" || ft === "gif") return "gif";
  if (mt === "text/plain" || ft === "text") return "txt";
  if (mt === "text/markdown" || ft === "markdown" || ft === "md") return "md";
  if (mt === "application/json" || ft === "json") return "json";

  const name = file.name || file.title || "";
  const m = name.match(/\.([A-Za-z0-9]{1,10})$/);
  return m ? m[1]!.toLowerCase() : null;
}

function passesContentTypeFilter(
  m: CompactSlackMessage,
  contentType: ContentType,
): boolean {
  if (contentType === "any") return true;
  const hasFiles = Boolean(m.files && m.files.length > 0);
  if (contentType === "text") return !hasFiles;
  if (!hasFiles) return false;

  if (contentType === "file") return true;
  if (contentType === "snippet") {
    return (m.files ?? []).some((f) => f.mode === "snippet");
  }
  if (contentType === "image") {
    return (m.files ?? []).some((f) => String(f.mimetype ?? "").startsWith("image/"));
  }
  return true;
}

function passesFileContentTypeFilter(
  f: { mode?: string; mimetype?: string },
  contentType: ContentType,
): boolean {
  if (contentType === "any") return true;
  if (contentType === "file") return true;
  if (contentType === "snippet") return f.mode === "snippet";
  if (contentType === "image")
    return String(f.mimetype ?? "").toLowerCase().startsWith("image/");
  if (contentType === "text") return String(f.mimetype ?? "") === "text/plain";
  return true;
}

async function searchMessagesViaSearchApi(
  client: SlackApiClient,
  auth: SlackAuth,
  input: {
    workspace_url?: string;
    slack_query: string;
    limit: number;
    maxContentChars: number;
    contentType: ContentType;
    download: boolean;
  },
): Promise<Array<Omit<CompactSlackMessage, "channel_id" | "thread_ts">>> {
  const matches = await searchMessagesRaw(client, input.slack_query, input.limit);
  if (!matches.length) return [];

  const messageRefs: Array<{ channel_id: string; message_ts: string }> = [];
  for (const m of matches) {
    const ts = String(m.ts ?? "").trim();
    if (!ts) continue;
    const channelId = m.channel?.id
      ? String(m.channel.id)
      : m.channel?.name
        ? await resolveChannelId(client, `#${String(m.channel.name)}`)
        : "";
    if (!channelId) continue;
    messageRefs.push({ channel_id: channelId, message_ts: ts });
    if (messageRefs.length >= input.limit) break;
  }

  const downloadedPaths: Record<string, string> = {};
  const downloadsDir = input.download ? await ensureDownloadsDir() : null;
  const out: Array<Omit<CompactSlackMessage, "channel_id" | "thread_ts">> = [];

  for (const ref of messageRefs) {
    const full = await fetchMessageByTs(client, {
      workspace_url: input.workspace_url ?? "",
      channel_id: ref.channel_id,
      message_ts: ref.message_ts,
    });

    if (downloadsDir) {
      await downloadFilesForMessage(auth, downloadsDir, full, downloadedPaths);
    }

    const compact = toCompactMessage(
      full,
      { maxBodyChars: input.maxContentChars },
      downloadedPaths,
    );
    if (!passesContentTypeFilter(compact, input.contentType)) continue;
    out.push(stripThreadListFields(compact));
    if (out.length >= input.limit) break;
  }

  return out;
}

async function searchMessagesInChannelsFallback(
  client: SlackApiClient,
  auth: SlackAuth,
  input: {
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
): Promise<Array<Omit<CompactSlackMessage, "channel_id" | "thread_ts">>> {
  const channelIds = await Promise.all(
    input.channels.map((c) => resolveChannelId(client, c)),
  );
  const queryLower = input.query.trim().toLowerCase();

  const userId = input.user
    ? await resolveUserId(client, input.user)
    : undefined;

  const afterSec = input.after ? dateToUnixSeconds(input.after, "start") : null;
  const beforeSec = input.before ? dateToUnixSeconds(input.before, "end") : null;

  const downloadsDir = input.download ? await ensureDownloadsDir() : null;
  const downloadedPaths: Record<string, string> = {};

  const results: Array<Omit<CompactSlackMessage, "channel_id" | "thread_ts">> =
    [];

  for (const channelId of channelIds) {
    let cursorLatest: string | undefined;
    for (;;) {
      const resp = await client.api("conversations.history", {
        channel: channelId,
        limit: 200,
        latest: cursorLatest,
      });
      const messages = (resp.messages ?? []) as any[];
      if (messages.length === 0) break;

      for (const m of messages) {
        const summary = messageSummaryFromApiMessage(channelId, m);

        const tsNum = Number.parseFloat(summary.ts);
        if (Number.isFinite(tsNum)) {
          if (beforeSec !== null && tsNum > beforeSec) continue;
          if (afterSec !== null && tsNum < afterSec) {
            // Older than our window; since we're scanning newest -> oldest, we can stop this channel.
            cursorLatest = undefined;
            break;
          }
        }

        if (userId && summary.user !== userId) continue;

        const content = renderSlackMessageContent(summary as any);
        if (queryLower && !content.toLowerCase().includes(queryLower)) continue;

        if (downloadsDir) {
          await downloadFilesForMessage(auth, downloadsDir, summary, downloadedPaths);
        }

        const compact = toCompactMessage(
          summary,
          { maxBodyChars: input.maxContentChars },
          downloadedPaths,
        );
        if (!passesContentTypeFilter(compact, input.contentType)) continue;

        results.push(stripThreadListFields(compact));
        if (results.length >= input.limit) return results;
      }

      // stop condition for after window (see above)
      if (!cursorLatest) break;

      // paginate older
      cursorLatest = messages[messages.length - 1]?.ts;
      if (!cursorLatest) break;
    }
  }

  return results;
}

async function searchFilesViaSearchApi(
  client: SlackApiClient,
  auth: SlackAuth,
  input: { slack_query: string; limit: number; contentType: ContentType },
): Promise<Array<{ title?: string; mimetype?: string; mode?: string; path: string }>> {
  const matches = await searchFilesRaw(client, input.slack_query, input.limit);
  if (!matches.length) return [];

  const downloadsDir = await ensureDownloadsDir();
  const out: Array<{ title?: string; mimetype?: string; mode?: string; path: string }> = [];

  for (const f of matches) {
    const mode = f.mode ? String(f.mode) : undefined;
    const mimetype = f.mimetype ? String(f.mimetype) : undefined;
    if (!passesFileContentTypeFilter({ mode, mimetype }, input.contentType)) continue;
    const url = (f.url_private_download || f.url_private) as string | undefined;
    if (!url) continue;
    const ext = inferExt(f);
    const path = await downloadSlackFile(
      auth,
      url,
      downloadsDir,
      `${String(f.id)}${ext ? `.${ext}` : ""}`,
    );
    out.push({
      title: (f.title || f.name || "").trim() || undefined,
      mimetype,
      mode,
      path,
    });
    if (out.length >= input.limit) break;
  }

  return out;
}

async function searchFilesInChannelsFallback(
  client: SlackApiClient,
  auth: SlackAuth,
  input: {
    query: string;
    channels: string[];
    user?: string;
    after?: string;
    before?: string;
    limit: number;
    contentType: ContentType;
  },
): Promise<Array<{ title?: string; mimetype?: string; mode?: string; path: string }>> {
  const channelIds = await Promise.all(
    input.channels.map((c) => resolveChannelId(client, c)),
  );
  const userId = input.user ? await resolveUserId(client, input.user) : undefined;
  const queryLower = input.query.trim().toLowerCase();

  const ts_from = input.after ? dateToUnixSeconds(input.after, "start") : undefined;
  const ts_to = input.before ? dateToUnixSeconds(input.before, "end") : undefined;

  const downloadsDir = await ensureDownloadsDir();
  const out: Array<{ title?: string; mimetype?: string; mode?: string; path: string }> = [];

  for (const channelId of channelIds) {
    let page = 1;
    for (;;) {
      const resp = await client.api("files.list", {
        channel: channelId,
        user: userId,
        ts_from,
        ts_to,
        count: 100,
        page,
      });
      const files = (resp.files ?? []) as any[];
      if (files.length === 0) break;

      for (const f of files) {
        const mode = f.mode ? String(f.mode) : undefined;
        const mimetype = f.mimetype ? String(f.mimetype) : undefined;
        if (!passesFileContentTypeFilter({ mode, mimetype }, input.contentType))
          continue;

        const title = (f.title || f.name || "").trim();
        if (queryLower && !title.toLowerCase().includes(queryLower)) continue;

        const url = (f.url_private_download || f.url_private) as string | undefined;
        if (!url) continue;

        const ext = inferExt(f);
        const path = await downloadSlackFile(
          auth,
          url,
          downloadsDir,
          `${String(f.id)}${ext ? `.${ext}` : ""}`,
        );
        out.push({
          title: title || undefined,
          mimetype,
          mode,
          path,
        });
        if (out.length >= input.limit) return out;
      }

      const paging = resp.paging ?? resp.pagination;
      const pages = paging?.pages ?? paging?.page_count;
      if (pages && page >= pages) break;
      page++;
    }
  }

  return out;
}

async function resolveUserId(client: SlackApiClient, input: string): Promise<string | undefined> {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  if (/^U[A-Z0-9]{8,}$/.test(trimmed)) return trimmed;
  const name = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;

  let cursor: string | undefined;
  for (;;) {
    const resp = await client.api("users.list", { limit: 200, cursor });
    const members = (resp.members ?? []) as any[];
    const found = members.find((m) => m?.name === name || m?.profile?.display_name === name);
    if (found?.id) return String(found.id);
    const next = resp.response_metadata?.next_cursor;
    if (!next) break;
    cursor = next;
  }
  return undefined;
}

function dateToUnixSeconds(date: string, edge: "start" | "end"): number {
  const d = validateDate(date);
  const iso = edge === "start" ? `${d}T00:00:00.000Z` : `${d}T23:59:59.999Z`;
  return Math.floor(Date.parse(iso) / 1000);
}

async function downloadFilesForMessage(
  auth: SlackAuth,
  downloadsDir: string,
  message: SlackMessageSummary,
  downloadedPaths: Record<string, string>,
): Promise<void> {
  for (const f of message.files ?? []) {
    if (downloadedPaths[f.id]) continue;
    const url = f.url_private_download || f.url_private;
    if (!url) continue;
    const ext = inferExt(f);
    const path = await downloadSlackFile(
      auth,
      url,
      downloadsDir,
      `${f.id}${ext ? `.${ext}` : ""}`,
    );
    downloadedPaths[f.id] = path;
  }
}

async function fetchMessageByTs(
  client: SlackApiClient,
  ref: { workspace_url: string; channel_id: string; message_ts: string },
): Promise<SlackMessageSummary> {
  const history = await client.api("conversations.history", {
    channel: ref.channel_id,
    latest: ref.message_ts,
    inclusive: true,
    limit: 5,
  });
  const messages = (history.messages ?? []) as any[];
  const found = messages.find((m) => m?.ts === ref.message_ts);
  if (!found) throw new Error("Message not found");
  return messageSummaryFromApiMessage(ref.channel_id, found);
}

function messageSummaryFromApiMessage(
  channelId: string,
  msg: any,
): SlackMessageSummary {
  const text = msg?.text ?? "";
  const files: SlackFileSummary[] | undefined = Array.isArray(msg?.files)
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

  return {
    channel_id: channelId,
    ts: String(msg?.ts ?? ""),
    thread_ts: msg?.thread_ts,
    reply_count: msg?.reply_count,
    user: msg?.user,
    bot_id: msg?.bot_id,
    text,
    markdown: slackMrkdwnToMarkdown(text),
    blocks: msg?.blocks,
    attachments: msg?.attachments,
    files,
    reactions: msg?.reactions,
  };
}
