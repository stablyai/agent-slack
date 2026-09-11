import type { CliContext } from "./context.ts";
import { parseMsgTarget } from "./targets.ts";
import { openDmChannel, resolveChannelId } from "../slack/channels.ts";
import type { SlackApiClient } from "../slack/client.ts";
import {
  cancelScheduledMessage as cancelScheduledMessageApi,
  listScheduledMessages as listScheduledMessagesApi,
  normalizeScheduleLimit,
} from "../slack/scheduled-messages.ts";
import { resolveSlackNativeDraftEndpoint } from "./slack-native-draft-endpoint.ts";

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
      const { client, auth, workspace_url } = await input.ctx.getClientForWorkspace(workspaceUrl);
      const channelId = channelTarget
        ? await resolveScheduledChannelTarget(client, channelTarget)
        : undefined;
      const endpoint = await resolveSlackNativeDraftEndpoint({
        ctx: input.ctx,
        client,
        auth,
        workspaceUrl: workspace_url ?? workspaceUrl,
      });
      return await listScheduledMessagesApi(endpoint.client, {
        channelId,
        cursor: input.options.cursor,
        oldest: input.options.oldest,
        latest: input.options.latest,
        limit: normalizeScheduleLimit(input.options.limit),
        authType: endpoint.auth.auth_type,
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
      const { client, auth, workspace_url } = await input.ctx.getClientForWorkspace(workspaceUrl);
      const channelId = await resolveScheduledChannelTarget(client, channelTarget);
      const endpoint = await resolveSlackNativeDraftEndpoint({
        ctx: input.ctx,
        client,
        auth,
        workspaceUrl: workspace_url ?? workspaceUrl,
      });
      await cancelScheduledMessageApi(endpoint.client, {
        channelId,
        scheduledMessageId: input.scheduledMessageId,
        authType: endpoint.auth.auth_type,
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
