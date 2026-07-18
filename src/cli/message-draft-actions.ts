import type { CliContext } from "./context.ts";
import { parseMsgTarget, type MsgTarget } from "./targets.ts";
import { warnOnTruncatedSlackUrl } from "./message-url-warning.ts";
import { normalizeChannelInput, openDmChannel, resolveChannelId } from "../slack/channels.ts";
import type { SlackApiClient } from "../slack/client.ts";
import {
  createDraft,
  deleteDraft,
  findDraft,
  listDrafts,
  updateDraft,
  type SlackDraft,
} from "../slack/drafts.ts";
import { fetchMessage } from "../slack/messages.ts";
import { getString, isRecord } from "../lib/object-type-guards.ts";
import { normalizeScheduleLimit } from "../slack/scheduled-messages.ts";

export async function listDraftsAction(input: {
  ctx: CliContext;
  options: { workspace?: string; limit?: string; all?: boolean };
}): Promise<Record<string, unknown>> {
  const workspaceUrl = input.ctx.effectiveWorkspaceUrl(input.options.workspace);
  return await input.ctx.withAutoRefresh({
    workspaceUrl,
    work: async () => {
      const { client } = await input.ctx.getClientForWorkspace(workspaceUrl);
      const { drafts } = await listDrafts(client, {
        limit: normalizeScheduleLimit(input.options.limit),
        activeOnly: !input.options.all,
      });
      const hydrated = await hydrateChannelNames(client, drafts);
      return { ok: true, drafts: hydrated, count: hydrated.length };
    },
  });
}

export async function createDraftAction(input: {
  ctx: CliContext;
  targetInput: string;
  text: string;
  options: { workspace?: string; threadTs?: string; broadcast?: boolean };
}): Promise<Record<string, unknown>> {
  const target = parseMsgTarget(String(input.targetInput));
  const workspaceUrl =
    target.kind === "url"
      ? target.ref.workspace_url
      : input.ctx.effectiveWorkspaceUrl(input.options.workspace);
  if (target.kind === "channel") {
    await input.ctx.assertWorkspaceSpecifiedForChannelNames({
      workspaceUrl,
      channels: [target.channel],
    });
  }
  // Validate --broadcast statically before any network round-trip, so an invalid
  // combination fails fast with the real reason (matches updateDraftAction).
  if (input.options.broadcast) {
    assertBroadcastAllowedStatically(target, input.options.threadTs);
  }

  return await input.ctx.withAutoRefresh({
    workspaceUrl,
    work: async () => {
      const { client } = await input.ctx.getClientForWorkspace(workspaceUrl);
      const { channelId, threadTs } = await resolveDraftDestination(client, {
        target,
        threadTs: input.options.threadTs,
      });
      // Backstop for URL targets, whose channel/thread are only known here.
      if (input.options.broadcast && isDmChannelId(channelId)) {
        throw new Error("--broadcast is not supported for DM targets.");
      }
      if (input.options.broadcast && !threadTs) {
        throw new Error("--broadcast requires a thread (use --thread-ts or a message URL target).");
      }
      const draft = await createDraft(client, {
        channelId,
        text: input.text,
        threadTs,
        broadcast: input.options.broadcast,
      });
      return { ok: true, draft };
    },
  });
}

export async function updateDraftAction(input: {
  ctx: CliContext;
  draftId: string;
  text: string;
  options: {
    workspace?: string;
    channel?: string;
    threadTs?: string;
    broadcast?: boolean;
    lastUpdatedTs?: string;
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
  // Validate an explicit --channel re-address statically, before any network
  // round-trip (findDraft / destination resolution), so an invalid --broadcast
  // combination fails fast with the real reason.
  if (input.options.broadcast && channelTarget) {
    assertBroadcastAllowedStatically(channelTarget, input.options.threadTs);
  }

  return await input.ctx.withAutoRefresh({
    workspaceUrl,
    work: async () => {
      const { client } = await input.ctx.getClientForWorkspace(workspaceUrl);
      // drafts.update replaces the whole draft, so start from the existing
      // one and override only what the caller passed.
      const existing = await findDraft(client, input.draftId);
      // The CLI rebuilds the draft from a single destination and no schedule, so
      // refuse drafts it can't faithfully round-trip rather than silently drop a
      // scheduled-send time or extra recipients (both are creatable in the Slack
      // client). Deleting + recreating, or editing in Slack, is the safe path.
      if (existing.date_scheduled) {
        throw new Error(
          `Draft ${input.draftId} has a scheduled send time; updating it here could clear the schedule. Edit it in the Slack client, or delete and recreate it.`,
        );
      }
      if (!channelTarget && existing.destinations.length > 1) {
        throw new Error(
          `Draft ${input.draftId} targets multiple destinations; updating its text here would drop all but the first. Edit it in the Slack client, or re-address it with --channel.`,
        );
      }
      const lastUpdatedTs = input.options.lastUpdatedTs ?? existing.last_updated_ts;
      if (!lastUpdatedTs) {
        throw new Error(`Draft ${input.draftId} has no last_updated_ts; pass --last-updated-ts.`);
      }
      const [destination] = existing.destinations;
      const resolved = channelTarget
        ? await resolveDraftDestination(client, {
            target: channelTarget,
            threadTs: input.options.threadTs,
          })
        : {
            channelId: destination?.channel_id,
            threadTs: input.options.threadTs ?? destination?.thread_ts,
          };
      if (!resolved.channelId) {
        throw new Error(`Draft ${input.draftId} has no destination; pass --channel.`);
      }
      // Inherit the existing broadcast flag only when the destination is truly
      // unchanged: same channel (no --channel) AND same thread. Changing the
      // thread (via --thread-ts) or re-addressing resets broadcast to what was
      // explicitly requested, so an inherited flag can never ratchet a reply
      // into a different thread's channel. `??` preserves an explicit
      // --no-broadcast.
      const broadcast =
        input.options.broadcast ??
        (!channelTarget && resolved.threadTs === destination?.thread_ts
          ? destination?.broadcast
          : undefined);
      // A DM (`D...`) destination — targeted directly, via URL, or an existing
      // DM draft — has no channel to broadcast to.
      if (broadcast && isDmChannelId(resolved.channelId)) {
        throw new Error("--broadcast is not supported for DM targets.");
      }
      if (broadcast && !resolved.threadTs) {
        throw new Error("--broadcast requires a thread (use --thread-ts).");
      }
      const draft = await updateDraft(client, {
        draftId: input.draftId,
        clientLastUpdatedTs: lastUpdatedTs,
        channelId: resolved.channelId,
        text: input.text,
        threadTs: resolved.threadTs,
        broadcast,
        fileIds: existing.file_ids,
      });
      return { ok: true, draft };
    },
  });
}

export async function deleteDraftAction(input: {
  ctx: CliContext;
  draftId: string;
  options: { workspace?: string; lastUpdatedTs?: string };
}): Promise<Record<string, unknown>> {
  const workspaceUrl = input.ctx.effectiveWorkspaceUrl(input.options.workspace);
  return await input.ctx.withAutoRefresh({
    workspaceUrl,
    work: async () => {
      const { client } = await input.ctx.getClientForWorkspace(workspaceUrl);
      await deleteDraft(client, {
        draftId: input.draftId,
        clientLastUpdatedTs: input.options.lastUpdatedTs,
      });
      return { ok: true, draft_id: input.draftId };
    },
  });
}

/** Slack 1:1 DM channels are `D...`; broadcast has no channel to target there. */
function isDmChannelId(channelId: string): boolean {
  return channelId.startsWith("D");
}

/**
 * Reject `--broadcast` combinations that are invalid regardless of what Slack
 * returns, before any network round-trip, so the error names the real problem
 * (a DM target, or a channel target with no thread) instead of an incidental
 * channel-name or message lookup failure. A message-URL target to a channel
 * derives its thread from the message, so it is validated after resolution.
 */
function assertBroadcastAllowedStatically(
  target: MsgTarget,
  threadTsOption: string | undefined,
): void {
  if (target.kind === "user") {
    throw new Error("--broadcast is not supported for DM targets.");
  }
  if (target.kind === "url") {
    if (isDmChannelId(target.ref.channel_id)) {
      throw new Error("--broadcast is not supported for DM targets.");
    }
    return;
  }
  const normalized = normalizeChannelInput(target.channel);
  if (normalized.kind === "id" && isDmChannelId(normalized.value)) {
    throw new Error("--broadcast is not supported for DM targets.");
  }
  if (!threadTsOption) {
    throw new Error("--broadcast requires a thread (use --thread-ts or a message URL target).");
  }
}

/**
 * Resolve a draft destination from a CLI target. Message-URL targets draft a
 * reply into that message's thread (same behavior as `message send`).
 */
async function resolveDraftDestination(
  client: SlackApiClient,
  input: { target: MsgTarget; threadTs?: string },
): Promise<{ channelId: string; threadTs?: string }> {
  const { target } = input;
  if (target.kind === "url") {
    warnOnTruncatedSlackUrl(target.ref);
    const msg = await fetchMessage(client, { ref: target.ref });
    return {
      channelId: target.ref.channel_id,
      threadTs: input.threadTs ?? msg.thread_ts ?? msg.ts,
    };
  }
  if (target.kind === "user") {
    return {
      channelId: await openDmChannel(client, target.userId),
      threadTs: input.threadTs,
    };
  }
  return {
    channelId: await resolveChannelId(client, target.channel),
    threadTs: input.threadTs,
  };
}

type HydratedDraft = SlackDraft & {
  destinations: (SlackDraft["destinations"][number] & { channel_name?: string })[];
};

/** Attach channel/DM display names to draft destinations (best-effort). */
async function hydrateChannelNames(
  client: SlackApiClient,
  drafts: SlackDraft[],
): Promise<HydratedDraft[]> {
  const channelIds = [
    ...new Set(drafts.flatMap((d) => d.destinations.map((dest) => dest.channel_id))),
  ];
  const names = new Map<string, string>();
  await Promise.all(
    channelIds.map(async (channelId) => {
      const name = await resolveChannelDisplayName(client, channelId);
      if (name) {
        names.set(channelId, name);
      }
    }),
  );
  return drafts.map((draft) => ({
    ...draft,
    destinations: draft.destinations.map((dest) => ({
      ...dest,
      channel_name: names.get(dest.channel_id),
    })),
  }));
}

async function resolveChannelDisplayName(
  client: SlackApiClient,
  channelId: string,
): Promise<string | undefined> {
  try {
    const info = await client.api("conversations.info", { channel: channelId });
    const ch = isRecord(info.channel) ? info.channel : null;
    if (!ch) {
      return undefined;
    }
    const name = getString(ch.name) ?? getString(ch.name_normalized);
    if (name) {
      return name;
    }
    if (ch.is_im) {
      const userId = getString(ch.user);
      if (userId) {
        const userInfo = await client.api("users.info", { user: userId });
        const u = isRecord(userInfo.user) ? userInfo.user : null;
        const profile = u && isRecord(u.profile) ? u.profile : null;
        return (
          getString(profile?.display_name) ||
          getString(u?.real_name) ||
          getString(u?.name) ||
          undefined
        );
      }
    }
  } catch {
    // best-effort — drafts still list without names
  }
  return undefined;
}
