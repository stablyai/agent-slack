import type { CliContext } from "./context.ts";
import type { SlackAuth } from "../slack/client.ts";
import type { SlackMessageSummary, CompactSlackMessage } from "../slack/messages.ts";
import { fetchMessage, fetchThread, toCompactMessage } from "../slack/messages.ts";
import { pruneEmpty } from "../lib/compact-json.ts";
import { ensureDownloadsDir } from "../lib/tmp-paths.ts";
import { parseMsgTarget } from "./targets.ts";
import { resolveChannelId } from "../slack/channels.ts";
import { downloadSlackFile } from "../slack/files.ts";
import { normalizeSlackReactionName } from "../slack/emoji.ts";

export type MessageCommandOptions = {
  maxBodyChars: string;
  workspace?: string;
  ts?: string;
  threadTs?: string;
  includeReactions?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

async function getThreadSummary(
  client: { api: (method: string, params?: Record<string, unknown>) => Promise<unknown> },
  input: {
    channelId: string;
    msg: { ts: string; thread_ts?: string; reply_count?: number };
  },
): Promise<{ ts: string; length: number } | null> {
  const replyCount = input.msg.reply_count ?? 0;
  const rootTs = input.msg.thread_ts ?? (replyCount > 0 ? input.msg.ts : null);
  if (!rootTs) {
    return null;
  }

  if (!input.msg.thread_ts && replyCount > 0) {
    return { ts: rootTs, length: 1 + replyCount };
  }

  const resp = await client.api("conversations.replies", {
    channel: input.channelId,
    ts: rootTs,
    limit: 1,
  });
  const [root] = asArray(isRecord(resp) ? resp.messages : undefined);
  const rootReplyCount = isRecord(root) ? getNumber(root.reply_count) : undefined;
  if (rootReplyCount === undefined) {
    return { ts: rootTs, length: 1 };
  }
  return { ts: rootTs, length: 1 + rootReplyCount };
}

function inferExt(file: {
  mimetype?: string;
  filetype?: string;
  name?: string;
  title?: string;
}): string | null {
  const mt = (file.mimetype || "").toLowerCase();
  const ft = (file.filetype || "").toLowerCase();

  if (mt === "image/png" || ft === "png") {
    return "png";
  }
  if (mt === "image/jpeg" || mt === "image/jpg" || ft === "jpg" || ft === "jpeg") {
    return "jpg";
  }
  if (mt === "image/webp" || ft === "webp") {
    return "webp";
  }
  if (mt === "image/gif" || ft === "gif") {
    return "gif";
  }

  if (mt === "text/plain" || ft === "text") {
    return "txt";
  }
  if (mt === "text/markdown" || ft === "markdown" || ft === "md") {
    return "md";
  }
  if (mt === "application/json" || ft === "json") {
    return "json";
  }

  const name = file.name || file.title || "";
  const m = name.match(/\.([A-Za-z0-9]{1,10})$/);
  return m ? m[1]!.toLowerCase() : null;
}

async function downloadFilesForMessages(input: {
  auth: SlackAuth;
  messages: SlackMessageSummary[];
}): Promise<Record<string, string>> {
  const downloadedPaths: Record<string, string> = {};
  const downloadsDir = await ensureDownloadsDir();

  for (const m of input.messages) {
    for (const f of m.files ?? []) {
      if (downloadedPaths[f.id]) {
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
        destDir: downloadsDir,
        preferredName: `${f.id}${ext ? `.${ext}` : ""}`,
      });
      downloadedPaths[f.id] = path;
    }
  }
  return downloadedPaths;
}

function toThreadListMessage(
  m: CompactSlackMessage,
): Omit<CompactSlackMessage, "channel_id" | "thread_ts"> {
  const { channel_id: _channelId, thread_ts: _threadTs, ...rest } = m;
  return rest;
}

export async function handleMessageGet(input: {
  ctx: CliContext;
  targetInput: string;
  options: MessageCommandOptions;
}): Promise<Record<string, unknown>> {
  const target = parseMsgTarget(input.targetInput);
  const workspaceUrl = input.ctx.effectiveWorkspaceUrl(input.options.workspace);

  return input.ctx.withAutoRefresh({
    workspaceUrl: target.kind === "url" ? target.ref.workspace_url : workspaceUrl,
    work: async () => {
      if (target.kind === "url") {
        const { ref } = target;
        const { client, auth } = await input.ctx.getClientForWorkspace(ref.workspace_url);
        const includeReactions = Boolean(input.options.includeReactions);
        const msg = await fetchMessage(client, { ref, includeReactions });
        const thread = await getThreadSummary(client, { channelId: ref.channel_id, msg });
        const downloadedPaths = await downloadFilesForMessages({ auth, messages: [msg] });
        const maxBodyChars = Number.parseInt(input.options.maxBodyChars, 10);
        const message = toCompactMessage(msg, { maxBodyChars, includeReactions, downloadedPaths });
        return pruneEmpty({ message, thread }) as Record<string, unknown>;
      }

      const ts = input.options.ts?.trim();
      if (!ts) {
        throw new Error('When targeting a channel, you must pass --ts "<seconds>.<micros>"');
      }

      await input.ctx.assertWorkspaceSpecifiedForChannelNames({
        workspaceUrl,
        channels: [target.channel],
      });

      const includeReactions = Boolean(input.options.includeReactions);
      const { client, auth, workspace_url } = await input.ctx.getClientForWorkspace(workspaceUrl);
      const channelId = await resolveChannelId(client, target.channel);
      const ref = {
        workspace_url: workspace_url ?? workspaceUrl ?? "",
        channel_id: channelId,
        message_ts: ts,
        thread_ts_hint: input.options.threadTs?.trim() || undefined,
        raw: input.targetInput,
      };

      const msg = await fetchMessage(client, { ref, includeReactions });
      const thread = await getThreadSummary(client, { channelId, msg });
      const downloadedPaths = await downloadFilesForMessages({ auth, messages: [msg] });
      const maxBodyChars = Number.parseInt(input.options.maxBodyChars, 10);
      const message = toCompactMessage(msg, { maxBodyChars, includeReactions, downloadedPaths });
      return pruneEmpty({ message, thread }) as Record<string, unknown>;
    },
  });
}

export async function handleMessageList(input: {
  ctx: CliContext;
  targetInput: string;
  options: MessageCommandOptions;
}): Promise<Record<string, unknown>> {
  const target = parseMsgTarget(input.targetInput);
  const workspaceUrl = input.ctx.effectiveWorkspaceUrl(input.options.workspace);

  return input.ctx.withAutoRefresh({
    workspaceUrl: target.kind === "url" ? target.ref.workspace_url : workspaceUrl,
    work: async () => {
      if (target.kind === "url") {
        const { ref } = target;
        const { client, auth } = await input.ctx.getClientForWorkspace(ref.workspace_url);
        const includeReactions = Boolean(input.options.includeReactions);
        const msg = await fetchMessage(client, { ref, includeReactions });
        const rootTs = msg.thread_ts ?? msg.ts;
        const threadMessages = await fetchThread(client, {
          channelId: ref.channel_id,
          threadTs: rootTs,
          includeReactions,
        });
        const downloadedPaths = await downloadFilesForMessages({ auth, messages: threadMessages });
        const maxBodyChars = Number.parseInt(input.options.maxBodyChars, 10);
        return pruneEmpty({
          messages: threadMessages
            .map((m) => toCompactMessage(m, { maxBodyChars, includeReactions, downloadedPaths }))
            .map(toThreadListMessage),
        }) as Record<string, unknown>;
      }

      const { client, auth, workspace_url } = await input.ctx.getClientForWorkspace(workspaceUrl);

      await input.ctx.assertWorkspaceSpecifiedForChannelNames({
        workspaceUrl,
        channels: [target.channel],
      });

      const channelId = await resolveChannelId(client, target.channel);

      const threadTs = input.options.threadTs?.trim();
      const ts = input.options.ts?.trim();
      if (!threadTs && !ts) {
        throw new Error(
          'When targeting a channel, you must pass --thread-ts "<seconds>.<micros>" (or --ts to resolve a message to its thread)',
        );
      }

      const rootTs =
        threadTs ??
        (await (async () => {
          const ref = {
            workspace_url: workspace_url ?? workspaceUrl ?? "",
            channel_id: channelId,
            message_ts: ts!,
            raw: input.targetInput,
          };
          const includeReactions = Boolean(input.options.includeReactions);
          const msg = await fetchMessage(client, { ref, includeReactions });
          return msg.thread_ts ?? msg.ts;
        })());

      const includeReactions = Boolean(input.options.includeReactions);
      const threadMessages = await fetchThread(client, {
        channelId,
        threadTs: rootTs,
        includeReactions,
      });
      const downloadedPaths = await downloadFilesForMessages({ auth, messages: threadMessages });
      const maxBodyChars = Number.parseInt(input.options.maxBodyChars, 10);
      return pruneEmpty({
        messages: threadMessages
          .map((m) => toCompactMessage(m, { maxBodyChars, includeReactions, downloadedPaths }))
          .map(toThreadListMessage),
      }) as Record<string, unknown>;
    },
  });
}

export async function sendMessage(input: {
  ctx: CliContext;
  targetInput: string;
  text: string;
  options: { workspace?: string; threadTs?: string };
}): Promise<Record<string, unknown>> {
  const target = parseMsgTarget(String(input.targetInput));
  if (target.kind === "url") {
    const { ref } = target;
    const resp = await input.ctx.withAutoRefresh({
      workspaceUrl: ref.workspace_url,
      work: async () => {
        const { client } = await input.ctx.getClientForWorkspace(ref.workspace_url);
        const msg = await fetchMessage(client, { ref });
        const threadTs = msg.thread_ts ?? msg.ts;
        return (await client.api("chat.postMessage", {
          channel: ref.channel_id,
          text: input.text,
          thread_ts: threadTs,
        })) as Record<string, unknown>;
      },
    });
    return pruneEmpty(resp) as Record<string, unknown>;
  }

  const workspaceUrl = input.ctx.effectiveWorkspaceUrl(input.options.workspace);
  await input.ctx.assertWorkspaceSpecifiedForChannelNames({
    workspaceUrl,
    channels: [String(target.channel)],
  });
  const resp = await input.ctx.withAutoRefresh({
    workspaceUrl,
    work: async () => {
      const { client } = await input.ctx.getClientForWorkspace(workspaceUrl);
      const channelId = await resolveChannelId(client, String(target.channel));
      return (await client.api("chat.postMessage", {
        channel: channelId,
        text: input.text,
        thread_ts: input.options.threadTs ? String(input.options.threadTs) : undefined,
      })) as Record<string, unknown>;
    },
  });
  return pruneEmpty(resp) as Record<string, unknown>;
}

export async function reactOnTarget(input: {
  ctx: CliContext;
  action: "add" | "remove";
  targetInput: string;
  emoji: string;
  options?: { workspace?: string; ts?: string };
}): Promise<Record<string, unknown>> {
  const target = parseMsgTarget(input.targetInput);
  const workspaceUrl = input.ctx.effectiveWorkspaceUrl(input.options?.workspace);

  const resolved = await input.ctx.withAutoRefresh({
    workspaceUrl: target.kind === "url" ? target.ref.workspace_url : workspaceUrl,
    work: async () => {
      if (target.kind === "url") {
        const { ref } = target;
        const { client } = await input.ctx.getClientForWorkspace(ref.workspace_url);
        const name = normalizeSlackReactionName(input.emoji);
        return (await client.api(`reactions.${input.action}`, {
          channel: ref.channel_id,
          timestamp: ref.message_ts,
          name,
        })) as Record<string, unknown>;
      }

      const ts = input.options?.ts?.trim();
      if (!ts) {
        throw new Error('When targeting a channel, you must pass --ts "<seconds>.<micros>"');
      }

      await input.ctx.assertWorkspaceSpecifiedForChannelNames({
        workspaceUrl,
        channels: [target.channel],
      });

      const { client } = await input.ctx.getClientForWorkspace(workspaceUrl);
      const channelId = await resolveChannelId(client, target.channel);
      const name = normalizeSlackReactionName(input.emoji);
      return (await client.api(`reactions.${input.action}`, {
        channel: channelId,
        timestamp: ts,
        name,
      })) as Record<string, unknown>;
    },
  });

  return pruneEmpty(resolved) as Record<string, unknown>;
}
