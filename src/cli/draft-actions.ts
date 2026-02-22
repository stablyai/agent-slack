import type { CliContext } from "./context.ts";
import { fetchMessage } from "../slack/messages.ts";
import { parseMsgTarget } from "./targets.ts";
import { resolveChannelId, normalizeChannelInput } from "../slack/channels.ts";
import { warnOnTruncatedSlackUrl } from "./message-url-warning.ts";
import { openDraftEditor } from "./draft-server.ts";

export async function draftMessage(input: {
  ctx: CliContext;
  targetInput: string;
  initialText?: string;
  options: { workspace?: string; threadTs?: string };
}): Promise<Record<string, unknown>> {
  const target = parseMsgTarget(String(input.targetInput));

  // URL target: resolve thread context and send
  if (target.kind === "url") {
    const { ref } = target;
    warnOnTruncatedSlackUrl(ref);
    return input.ctx.withAutoRefresh({
      workspaceUrl: ref.workspace_url,
      work: async () => {
        const { client } = await input.ctx.getClientForWorkspace(ref.workspace_url);
        const msg = await fetchMessage(client, { ref });
        const threadTs = input.options.threadTs ?? msg.thread_ts ?? msg.ts;

        return draftWithEditor({
          channelName: ref.channel_id,
          channelId: ref.channel_id,
          workspaceUrl: ref.workspace_url,
          threadTs,
          initialText: input.initialText,
          sendFn: async (text: string) => {
            await client.api("chat.postMessage", {
              channel: ref.channel_id,
              text,
              thread_ts: threadTs,
            });
          },
        });
      },
    });
  }

  // Channel name/ID target
  const workspaceUrl = input.ctx.effectiveWorkspaceUrl(input.options.workspace);
  await input.ctx.assertWorkspaceSpecifiedForChannelNames({
    workspaceUrl,
    channels: [String(target.channel)],
  });

  return input.ctx.withAutoRefresh({
    workspaceUrl,
    work: async () => {
      const { client } = await input.ctx.getClientForWorkspace(workspaceUrl);
      const channelId = await resolveChannelId(client, String(target.channel));
      const normalized = normalizeChannelInput(target.channel);
      const channelName = normalized.kind === "name" ? normalized.value : channelId;

      return draftWithEditor({
        channelName,
        channelId,
        workspaceUrl,
        threadTs: input.options.threadTs,
        initialText: input.initialText,
        sendFn: async (text: string) => {
          await client.api("chat.postMessage", {
            channel: channelId,
            text,
            thread_ts: input.options.threadTs,
          });
        },
      });
    },
  });
}

async function draftWithEditor(input: {
  channelName: string;
  channelId: string;
  workspaceUrl?: string;
  threadTs?: string;
  initialText?: string;
  sendFn: (text: string) => Promise<void>;
}): Promise<Record<string, unknown>> {
  // In CI mode, skip the editor and send directly
  if (process.env.CI) {
    if (!input.initialText) {
      throw new Error("In CI mode, initial text is required (no editor available)");
    }
    await input.sendFn(input.initialText);
    return { ok: true, sent: true, editor: "skipped" };
  }

  const result = await openDraftEditor({
    channelName: input.channelName,
    channelId: input.channelId,
    workspaceUrl: input.workspaceUrl,
    threadTs: input.threadTs,
    initialText: input.initialText,
    onSend: input.sendFn,
  });

  if ("cancelled" in result) {
    return { ok: true, cancelled: true };
  }

  return { ok: true, sent: true };
}
