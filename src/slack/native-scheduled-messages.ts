import type { SlackApiClient } from "./client.ts";
import { getNumber } from "../lib/object-type-guards.ts";
import { createDraft, deleteDraft, findDraft, listDrafts, type SlackDraft } from "./drafts.ts";

export async function scheduleNativeMessage(
  client: SlackApiClient,
  input: {
    channelId: string;
    text: string;
    postAt: number;
    threadTs?: string;
    replyBroadcast?: boolean;
    blocks?: unknown[] | null;
    unfurl?: boolean;
  },
): Promise<Record<string, unknown>> {
  if (input.unfurl === false) {
    throw new Error(
      "--no-unfurl is not supported with browser-auth scheduled messages because Slack-native scheduled drafts do not preserve that option.",
    );
  }
  const draft = await createDraft(client, {
    channelId: input.channelId,
    text: input.text,
    ...(input.blocks ? { blocks: input.blocks } : {}),
    threadTs: input.threadTs,
    broadcast: input.replyBroadcast,
    dateScheduled: input.postAt,
  });
  const destination = draft?.destinations[0];
  if (
    !draft ||
    draft.date_scheduled !== input.postAt ||
    draft.destinations.length !== 1 ||
    !destination ||
    destination.channel_id !== input.channelId ||
    destination.thread_ts !== input.threadTs ||
    Boolean(destination.broadcast) !== Boolean(input.threadTs && input.replyBroadcast)
  ) {
    throw new Error("Slack did not confirm a matching native scheduled draft.");
  }
  return {
    channel: destination.channel_id,
    scheduled_message_id: draft.id,
    post_at: draft.date_scheduled,
  };
}

export async function listNativeScheduledMessages(
  client: SlackApiClient,
  options: {
    channelId?: string;
    cursor?: string;
    oldest?: string;
    latest?: string;
    limit?: number;
  },
): Promise<{
  ok: true;
  scheduled_messages: Record<string, unknown>[];
  has_more?: boolean;
}> {
  if (options.cursor?.trim()) {
    throw new Error("--cursor is not supported for Slack-native scheduled drafts.");
  }
  const oldest = parseOptionalScheduleBound(options.oldest, "--oldest");
  const latest = parseOptionalScheduleBound(options.latest, "--latest");
  const { drafts, has_more: hasMore } = await listDrafts(client, { limit: 100 });
  const matching = drafts
    .flatMap((draft) => nativeScheduledMessage(draft, options.channelId))
    .filter((message) => {
      const postAt = getNumber(message.post_at)!;
      return (
        (oldest === undefined || postAt >= oldest) && (latest === undefined || postAt <= latest)
      );
    });
  const scheduledMessages =
    options.limit === undefined ? matching : matching.slice(0, options.limit);
  return {
    ok: true,
    scheduled_messages: scheduledMessages,
    ...(hasMore ? { has_more: true } : {}),
  };
}

export async function cancelNativeScheduledMessage(
  client: SlackApiClient,
  input: { channelId: string; scheduledMessageId: string },
): Promise<void> {
  const draft = await findDraft(client, input.scheduledMessageId);
  if (!draft.date_scheduled) {
    throw new Error(`Draft ${input.scheduledMessageId} is not a pending scheduled message.`);
  }
  if (!draft.destinations.some((destination) => destination.channel_id === input.channelId)) {
    throw new Error(
      `Scheduled draft ${input.scheduledMessageId} does not target channel ${input.channelId}.`,
    );
  }
  await deleteDraft(client, {
    draftId: draft.id,
    clientLastUpdatedTs: draft.last_updated_ts,
  });
}

function nativeScheduledMessage(draft: SlackDraft, channelId?: string): Record<string, unknown>[] {
  const postAt = draft.date_scheduled;
  if (!postAt || !Number.isSafeInteger(postAt)) {
    return [];
  }
  const destination = channelId
    ? draft.destinations.find((candidate) => candidate.channel_id === channelId)
    : draft.destinations[0];
  if (!destination) {
    return [];
  }
  return [
    {
      id: draft.id,
      channel_id: destination.channel_id,
      post_at: postAt,
      ...(draft.text !== undefined ? { text: draft.text } : {}),
      ...(destination.thread_ts ? { thread_ts: destination.thread_ts } : {}),
      ...(destination.broadcast ? { reply_broadcast: true } : {}),
    },
  ];
}

function parseOptionalScheduleBound(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid ${flag} value ${JSON.stringify(raw)}: must be a Unix timestamp`);
  }
  return value;
}
