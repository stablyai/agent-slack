import type { CliContext } from "./context.ts";
import {
  fetchMessage,
  fetchThread,
  fetchChannelHistory,
  toCompactMessage,
} from "../slack/messages.ts";
import { pruneEmpty } from "../lib/compact-json.ts";
import { parseMsgTarget } from "./targets.ts";
import { resolveChannelId } from "../slack/channels.ts";
import { normalizeSlackReactionName } from "../slack/emoji.ts";
import { downloadMessageFiles } from "./message-file-downloads.ts";
import { warnOnTruncatedSlackUrl } from "./message-url-warning.ts";
import { getThreadSummary, toThreadListMessage } from "./message-thread-info.ts";

export type MessageCommandOptions = {
  maxBodyChars: string;
  workspace?: string;
  ts?: string;
  threadTs?: string;
  limit?: string;
  oldest?: string;
  latest?: string;
  withReaction?: string[];
  withoutReaction?: string[];
  includeReactions?: boolean;
};

export function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`Invalid --limit value "${raw}": must be a positive integer`);
  }
  return n;
}

export function requireMessageTs(raw: string | undefined): string {
  const ts = raw?.trim();
  if (!ts) {
    throw new Error('When targeting a channel, you must pass --ts "<seconds>.<micros>"');
  }
  return ts;
}

export function parseReactionFilters(raw: string[] | undefined): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [];
  }
  const out: string[] = [];
  for (const value of raw) {
    const normalized = normalizeSlackReactionName(String(value));
    if (!out.includes(normalized)) {
      out.push(normalized);
    }
  }
  return out;
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
        warnOnTruncatedSlackUrl(ref);
        const { client, auth } = await input.ctx.getClientForWorkspace(ref.workspace_url);
        const includeReactions = Boolean(input.options.includeReactions);
        const msg = await fetchMessage(client, { ref, includeReactions });
        const thread = await getThreadSummary(client, { channelId: ref.channel_id, msg });
        const downloadedPaths = await downloadMessageFiles({ auth, messages: [msg] });
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
      const downloadedPaths = await downloadMessageFiles({ auth, messages: [msg] });
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
      const withReactions = parseReactionFilters(input.options.withReaction);
      const withoutReactions = parseReactionFilters(input.options.withoutReaction);
      const hasReactionFilters = withReactions.length > 0 || withoutReactions.length > 0;

      if (target.kind === "url") {
        if (hasReactionFilters) {
          throw new Error(
            "Reaction filters are only supported for channel history mode (not message URL thread mode)",
          );
        }
        const { ref } = target;
        warnOnTruncatedSlackUrl(ref);
        const { client, auth } = await input.ctx.getClientForWorkspace(ref.workspace_url);
        const includeReactions = Boolean(input.options.includeReactions);
        const msg = await fetchMessage(client, { ref, includeReactions });
        const rootTs = msg.thread_ts ?? msg.ts;
        const threadMessages = await fetchThread(client, {
          channelId: ref.channel_id,
          threadTs: rootTs,
          includeReactions,
        });
        const downloadedPaths = await downloadMessageFiles({ auth, messages: threadMessages });
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

      // No thread specifier → list recent channel messages
      if (!threadTs && !ts) {
        const includeReactions = Boolean(input.options.includeReactions);
        const limit = parseLimit(input.options.limit);
        const channelMessages = await fetchChannelHistory(client, {
          channelId,
          limit,
          latest: input.options.latest?.trim(),
          oldest: input.options.oldest?.trim(),
          includeReactions: includeReactions || hasReactionFilters,
          withReactions,
          withoutReactions,
        });
        const downloadedPaths = await downloadMessageFiles({ auth, messages: channelMessages });
        const maxBodyChars = Number.parseInt(input.options.maxBodyChars, 10);
        return pruneEmpty({
          channel_id: channelId,
          messages: channelMessages.map((m) =>
            toCompactMessage(m, { maxBodyChars, includeReactions, downloadedPaths }),
          ),
        }) as Record<string, unknown>;
      }

      if (hasReactionFilters) {
        throw new Error(
          "Reaction filters are only supported for channel history mode (without --thread-ts/--ts)",
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
      const downloadedPaths = await downloadMessageFiles({ auth, messages: threadMessages });
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
    warnOnTruncatedSlackUrl(ref);
    await input.ctx.withAutoRefresh({
      workspaceUrl: ref.workspace_url,
      work: async () => {
        const { client } = await input.ctx.getClientForWorkspace(ref.workspace_url);
        const msg = await fetchMessage(client, { ref });
        const threadTs = msg.thread_ts ?? msg.ts;
        await client.api("chat.postMessage", {
          channel: ref.channel_id,
          text: input.text,
          thread_ts: threadTs,
        });
      },
    });
    return { ok: true };
  }

  const workspaceUrl = input.ctx.effectiveWorkspaceUrl(input.options.workspace);
  await input.ctx.assertWorkspaceSpecifiedForChannelNames({
    workspaceUrl,
    channels: [String(target.channel)],
  });
  await input.ctx.withAutoRefresh({
    workspaceUrl,
    work: async () => {
      const { client } = await input.ctx.getClientForWorkspace(workspaceUrl);
      const channelId = await resolveChannelId(client, String(target.channel));
      await client.api("chat.postMessage", {
        channel: channelId,
        text: input.text,
        thread_ts: input.options.threadTs ? String(input.options.threadTs) : undefined,
      });
    },
  });
  return { ok: true };
}

export async function editMessage(input: {
  ctx: CliContext;
  targetInput: string;
  text: string;
  options: { workspace?: string; ts?: string };
}): Promise<Record<string, unknown>> {
  const target = parseMsgTarget(String(input.targetInput));
  const workspaceUrl = input.ctx.effectiveWorkspaceUrl(input.options.workspace);

  await input.ctx.withAutoRefresh({
    workspaceUrl: target.kind === "url" ? target.ref.workspace_url : workspaceUrl,
    work: async () => {
      if (target.kind === "url") {
        const { ref } = target;
        warnOnTruncatedSlackUrl(ref);
        const { client } = await input.ctx.getClientForWorkspace(ref.workspace_url);
        await client.api("chat.update", {
          channel: ref.channel_id,
          ts: ref.message_ts,
          text: input.text,
        });
        return;
      }

      const ts = requireMessageTs(input.options.ts);
      await input.ctx.assertWorkspaceSpecifiedForChannelNames({
        workspaceUrl,
        channels: [target.channel],
      });
      const { client } = await input.ctx.getClientForWorkspace(workspaceUrl);
      const channelId = await resolveChannelId(client, target.channel);
      await client.api("chat.update", {
        channel: channelId,
        ts,
        text: input.text,
      });
    },
  });

  return { ok: true };
}

export async function deleteMessage(input: {
  ctx: CliContext;
  targetInput: string;
  options: { workspace?: string; ts?: string };
}): Promise<Record<string, unknown>> {
  const target = parseMsgTarget(String(input.targetInput));
  const workspaceUrl = input.ctx.effectiveWorkspaceUrl(input.options.workspace);

  await input.ctx.withAutoRefresh({
    workspaceUrl: target.kind === "url" ? target.ref.workspace_url : workspaceUrl,
    work: async () => {
      if (target.kind === "url") {
        const { ref } = target;
        warnOnTruncatedSlackUrl(ref);
        const { client } = await input.ctx.getClientForWorkspace(ref.workspace_url);
        await client.api("chat.delete", {
          channel: ref.channel_id,
          ts: ref.message_ts,
        });
        return;
      }

      const ts = requireMessageTs(input.options.ts);
      await input.ctx.assertWorkspaceSpecifiedForChannelNames({
        workspaceUrl,
        channels: [target.channel],
      });
      const { client } = await input.ctx.getClientForWorkspace(workspaceUrl);
      const channelId = await resolveChannelId(client, target.channel);
      await client.api("chat.delete", {
        channel: channelId,
        ts,
      });
    },
  });

  return { ok: true };
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

  await input.ctx.withAutoRefresh({
    workspaceUrl: target.kind === "url" ? target.ref.workspace_url : workspaceUrl,
    work: async () => {
      if (target.kind === "url") {
        const { ref } = target;
        warnOnTruncatedSlackUrl(ref);
        const { client } = await input.ctx.getClientForWorkspace(ref.workspace_url);
        const name = normalizeSlackReactionName(input.emoji);
        await client.api(`reactions.${input.action}`, {
          channel: ref.channel_id,
          timestamp: ref.message_ts,
          name,
        });
        return;
      }

      const ts = requireMessageTs(input.options?.ts);

      await input.ctx.assertWorkspaceSpecifiedForChannelNames({
        workspaceUrl,
        channels: [target.channel],
      });

      const { client } = await input.ctx.getClientForWorkspace(workspaceUrl);
      const channelId = await resolveChannelId(client, target.channel);
      const name = normalizeSlackReactionName(input.emoji);
      await client.api(`reactions.${input.action}`, {
        channel: channelId,
        timestamp: ts,
        name,
      });
    },
  });

  return { ok: true };
}
