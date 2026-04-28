import type { CliContext } from "./context.ts";
import { fetchMessage } from "../slack/messages.ts";
import { parseMsgTarget } from "./targets.ts";
import { resolveChannelId, openDmChannel } from "../slack/channels.ts";
import { normalizeSlackReactionName } from "../slack/emoji.ts";
import { warnOnTruncatedSlackUrl } from "./message-url-warning.ts";
import { textToRichTextBlocks } from "../slack/rich-text.ts";
import type { SlackApiClient } from "../slack/client.ts";
import { uploadLocalFileToSlack } from "../slack/upload.ts";
import { buildSlackMessageUrl } from "../slack/url.ts";

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
  resolveUsers?: boolean;
  refreshUsers?: boolean;
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

export function requireOldestWhenReactionFiltersUsed(input: {
  oldest?: string;
  withReactions: string[];
  withoutReactions: string[];
}): string | undefined {
  const hasReactionFilters = input.withReactions.length > 0 || input.withoutReactions.length > 0;
  const oldest = input.oldest?.trim();
  if (!hasReactionFilters) {
    return oldest;
  }
  if (!oldest) {
    throw new Error(
      'Reaction filters require --oldest "<seconds>.<micros>" to bound scan size. Example: --oldest "1770165109.628379"',
    );
  }
  return oldest;
}

export async function sendMessage(input: {
  ctx: CliContext;
  targetInput: string;
  text: string;
  options: { workspace?: string; threadTs?: string; attach?: string[] };
}): Promise<Record<string, unknown>> {
  const target = parseMsgTarget(String(input.targetInput));
  const blocks = input.text ? textToRichTextBlocks(input.text) : null;
  const attachPaths = normalizeAttachPaths(input.options.attach);

  if (target.kind === "url") {
    const { ref } = target;
    warnOnTruncatedSlackUrl(ref);
    return await input.ctx.withAutoRefresh({
      workspaceUrl: ref.workspace_url,
      work: async () => {
        const { client, workspace_url } = await input.ctx.getClientForWorkspace(ref.workspace_url);
        const msg = await fetchMessage(client, { ref });
        const threadTs = msg.thread_ts ?? msg.ts;
        return await sendMessageToChannel({
          client,
          workspaceUrl: workspace_url ?? ref.workspace_url,
          channelId: ref.channel_id,
          text: input.text,
          blocks,
          threadTs,
          attachPaths,
        });
      },
    });
  }

  if (target.kind === "user") {
    const workspaceUrl = input.ctx.effectiveWorkspaceUrl(input.options.workspace);
    return await input.ctx.withAutoRefresh({
      workspaceUrl,
      work: async () => {
        const { client, workspace_url } = await input.ctx.getClientForWorkspace(workspaceUrl);
        const dmChannelId = await openDmChannel(client, target.userId);
        return await sendMessageToChannel({
          client,
          workspaceUrl: workspace_url ?? workspaceUrl,
          channelId: dmChannelId,
          text: input.text,
          blocks,
          attachPaths,
        });
      },
    });
  }

  const workspaceUrl = input.ctx.effectiveWorkspaceUrl(input.options.workspace);
  await input.ctx.assertWorkspaceSpecifiedForChannelNames({
    workspaceUrl,
    channels: [String(target.channel)],
  });
  return await input.ctx.withAutoRefresh({
    workspaceUrl,
    work: async () => {
      const { client, workspace_url } = await input.ctx.getClientForWorkspace(workspaceUrl);
      const channelId = await resolveChannelId(client, String(target.channel));
      return await sendMessageToChannel({
        client,
        workspaceUrl: workspace_url ?? workspaceUrl,
        channelId,
        text: input.text,
        blocks,
        threadTs: input.options.threadTs ? String(input.options.threadTs) : undefined,
        attachPaths,
      });
    },
  });
}

function normalizeAttachPaths(raw: string[] | undefined): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [];
  }
  const out: string[] = [];
  for (const p of raw.map((v) => String(v).trim()).filter(Boolean)) {
    if (!out.includes(p)) {
      out.push(p);
    }
  }
  return out;
}

async function sendMessageToChannel(input: {
  client: SlackApiClient;
  workspaceUrl?: string;
  channelId: string;
  text: string;
  blocks?: unknown[] | null;
  threadTs?: string;
  attachPaths: string[];
}): Promise<Record<string, unknown>> {
  if (input.attachPaths.length === 0) {
    const resp = await input.client.api("chat.postMessage", {
      channel: input.channelId,
      text: input.text,
      thread_ts: input.threadTs,
      ...(input.blocks ? { blocks: input.blocks } : {}),
    });
    const ts = typeof resp.ts === "string" ? resp.ts : undefined;
    const channelId = typeof resp.channel === "string" ? resp.channel : input.channelId;
    const permalink =
      input.workspaceUrl && ts
        ? buildSlackMessageUrl({
            workspace_url: input.workspaceUrl,
            channel_id: channelId,
            message_ts: ts,
            thread_ts: input.threadTs,
          })
        : undefined;
    return {
      ok: true,
      channel_id: channelId,
      ts,
      thread_ts: input.threadTs,
      permalink,
    };
  }

  if (input.blocks) {
    process.stderr.write(
      "Warning: rich text formatting is not supported with file attachments; sending as plain text.\n",
    );
  }

  let initialComment = input.text;
  for (const filePath of input.attachPaths) {
    await uploadLocalFileToSlack({
      client: input.client,
      channelId: input.channelId,
      filePath,
      threadTs: input.threadTs,
      initialComment,
    });
    initialComment = "";
  }

  return {
    ok: true,
    channel_id: input.channelId,
    thread_ts: input.threadTs,
  };
}

export async function editMessage(input: {
  ctx: CliContext;
  targetInput: string;
  text: string;
  options: { workspace?: string; ts?: string };
}): Promise<Record<string, unknown>> {
  const target = parseMsgTarget(String(input.targetInput));
  if (target.kind === "user") {
    throw new Error(
      "message edit does not support user ID targets. Use a channel name, channel ID, or message URL.",
    );
  }
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
  if (target.kind === "user") {
    throw new Error(
      "message delete does not support user ID targets. Use a channel name, channel ID, or message URL.",
    );
  }
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
  if (target.kind === "user") {
    throw new Error(
      "react does not support user ID targets. Use a channel name, channel ID, or message URL.",
    );
  }
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

export { handleMessageGet, handleMessageList } from "./message-read-actions.ts";
