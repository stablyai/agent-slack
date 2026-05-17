import type { CliContext } from "./context.ts";
import { parseMsgTarget } from "./targets.ts";
import { resolveChannelId, openDmChannel } from "../slack/channels.ts";
import { uploadLocalFileToSlack } from "../slack/upload.ts";
import { fetchMessage } from "../slack/messages.ts";
import { warnOnTruncatedSlackUrl } from "./message-url-warning.ts";

export async function uploadFile(input: {
  ctx: CliContext;
  targetInput: string;
  filePaths: string[];
  options: { workspace?: string; threadTs?: string; comment?: string };
}): Promise<Record<string, unknown>> {
  const target = parseMsgTarget(String(input.targetInput));
  const dedupedPaths = [...new Set(input.filePaths.map((p) => p.trim()).filter(Boolean))];

  if (target.kind === "url") {
    const { ref } = target;
    warnOnTruncatedSlackUrl(ref);
    return await input.ctx.withAutoRefresh({
      workspaceUrl: ref.workspace_url,
      work: async () => {
        const { client } = await input.ctx.getClientForWorkspace(ref.workspace_url);
        const msg = await fetchMessage(client, { ref });
        const threadTs = msg.thread_ts ?? msg.ts;
        return await uploadFiles({
          client,
          channelId: ref.channel_id,
          filePaths: dedupedPaths,
          threadTs,
          comment: input.options.comment,
        });
      },
    });
  }

  if (target.kind === "user") {
    const workspaceUrl = input.ctx.effectiveWorkspaceUrl(input.options.workspace);
    return await input.ctx.withAutoRefresh({
      workspaceUrl,
      work: async () => {
        const { client } = await input.ctx.getClientForWorkspace(workspaceUrl);
        const dmChannelId = await openDmChannel(client, target.userId);
        return await uploadFiles({
          client,
          channelId: dmChannelId,
          filePaths: dedupedPaths,
          threadTs: input.options.threadTs,
          comment: input.options.comment,
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
      const { client } = await input.ctx.getClientForWorkspace(workspaceUrl);
      const channelId = await resolveChannelId(client, String(target.channel));
      return await uploadFiles({
        client,
        channelId,
        filePaths: dedupedPaths,
        threadTs: input.options.threadTs,
        comment: input.options.comment,
      });
    },
  });
}

async function uploadFiles(input: {
  client: Parameters<typeof uploadLocalFileToSlack>[0]["client"];
  channelId: string;
  filePaths: string[];
  threadTs?: string;
  comment?: string;
}): Promise<Record<string, unknown>> {
  let initialComment = input.comment;
  for (const filePath of input.filePaths) {
    await uploadLocalFileToSlack({
      client: input.client,
      channelId: input.channelId,
      filePath,
      threadTs: input.threadTs,
      initialComment,
    });
    initialComment = undefined;
  }

  return {
    ok: true,
    channel_id: input.channelId,
    files_uploaded: input.filePaths.length,
  };
}
