import type { CliContext } from "./context.ts";
import { parseMsgTarget } from "./targets.ts";
import { openDmChannel, resolveChannelId } from "../slack/channels.ts";
import type { SlackApiClient } from "../slack/client.ts";
import {
  cancelScheduledMessage as cancelScheduledMessageApi,
  listScheduledMessages as listScheduledMessagesApi,
  normalizeScheduleLimit,
} from "../slack/scheduled-messages.ts";

export async function listScheduledMessages(input: {
  ctx: CliContext;
  options: {
    workspace?: string;
    channel?: string;
    cursor?: string;
    oldest?: string;
    latest?: string;
    limit?: string;
  };
}): Promise<Record<string, unknown>> {
  const channelTarget = input.options.channel
    ? parseMsgTarget(String(input.options.channel))
    : undefined;
  const workspaceUrl =
    channelTarget?.kind === "url"
      ? channelTarget.ref.workspace_url
      : input.ctx.effectiveWorkspaceUrl(input.options.workspace);
  if (channelTarget?.kind === "channel") {
    await input.ctx.assertWorkspaceSpecifiedForChannelNames({
      workspaceUrl,
      channels: [channelTarget.channel],
    });
  }

  return await input.ctx.withAutoRefresh({
    workspaceUrl,
    work: async () => {
      const { client } = await input.ctx.getClientForWorkspace(workspaceUrl);
      const channelId = channelTarget
        ? await resolveScheduledChannelTarget(client, channelTarget)
        : undefined;
      return await listScheduledMessagesApi(client, {
        channelId,
        cursor: input.options.cursor,
        oldest: input.options.oldest,
        latest: input.options.latest,
        limit: normalizeScheduleLimit(input.options.limit),
      });
    },
  });
}

export async function cancelScheduledMessage(input: {
  ctx: CliContext;
  scheduledMessageId: string;
  options: { workspace?: string; channel: string };
}): Promise<Record<string, unknown>> {
  const channelTarget = parseMsgTarget(String(input.options.channel));
  const workspaceUrl =
    channelTarget.kind === "url"
      ? channelTarget.ref.workspace_url
      : input.ctx.effectiveWorkspaceUrl(input.options.workspace);
  if (channelTarget.kind === "channel") {
    await input.ctx.assertWorkspaceSpecifiedForChannelNames({
      workspaceUrl,
      channels: [channelTarget.channel],
    });
  }

  return await input.ctx.withAutoRefresh({
    workspaceUrl,
    work: async () => {
      const { client } = await input.ctx.getClientForWorkspace(workspaceUrl);
      const channelId = await resolveScheduledChannelTarget(client, channelTarget);
      await cancelScheduledMessageApi(client, {
        channelId,
        scheduledMessageId: input.scheduledMessageId,
      });
      return {
        ok: true,
        channel_id: channelId,
        scheduled_message_id: input.scheduledMessageId,
      };
    },
  });
}

async function resolveScheduledChannelTarget(
  client: SlackApiClient,
  target: ReturnType<typeof parseMsgTarget>,
): Promise<string> {
  if (target.kind === "url") {
    return target.ref.channel_id;
  }
  if (target.kind === "user") {
    return await openDmChannel(client, target.userId);
  }
  return await resolveChannelId(client, target.channel);
}
