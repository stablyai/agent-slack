import { slackErrorResponse, type SlackApiClient, type SlackErrorResponse } from "./client.ts";
import { normalizeChannelInput, resolveChannelIdIncludingArchived } from "./channels.ts";
import { asArray, getString, isRecord } from "../lib/object-type-guards.ts";

export async function createChannel(
  client: SlackApiClient,
  input: { name: string; isPrivate?: boolean },
): Promise<{ channel: { id: string; name: string; is_private: boolean } }> {
  const name = input.name.trim();
  if (!name) {
    throw new Error("Channel name is empty");
  }

  const resp = await client.api("conversations.create", {
    name,
    is_private: Boolean(input.isPrivate),
  });
  const channel = isRecord(resp.channel) ? resp.channel : null;
  const id = channel ? getString(channel.id) : undefined;
  const channelName = channel ? getString(channel.name) : undefined;
  const isPrivate =
    channel && typeof channel.is_private === "boolean"
      ? channel.is_private
      : Boolean(input.isPrivate);

  if (!id || !channelName) {
    throw new Error("conversations.create returned no channel");
  }

  return {
    channel: {
      id,
      name: channelName,
      is_private: isPrivate,
    },
  };
}

export type ChannelJoin = {
  channel: { id: string; name?: string };
  status: "joined" | "already_in_channel";
};

/**
 * Joins the authenticated user to a public channel given as an ID, `#name` or name.
 * A name matches an archived channel only if no live channel has it, so Slack can say it is archived.
 */
export async function joinChannel(
  client: SlackApiClient,
  input: { channel: string },
): Promise<ChannelJoin> {
  const channelId = await resolveChannelIdToJoin(client, input.channel);
  let resp: Record<string, unknown>;
  try {
    resp = await client.api("conversations.join", { channel: channelId });
  } catch (err: unknown) {
    const response = slackErrorResponse(err);
    const reason = response ? joinRefusalReason(response) : undefined;
    if (reason) {
      throw new Error(`Cannot join ${channelId}: ${reason}`, { cause: err });
    }
    throw err;
  }

  const channel = isRecord(resp.channel) ? resp.channel : {};
  const meta = isRecord(resp.response_metadata) ? resp.response_metadata : {};
  return {
    channel: { id: channelId, name: getString(channel.name) },
    status: asArray(meta.warnings).includes("already_in_channel") ? "already_in_channel" : "joined",
  };
}

/** What a `conversations.join` error means to the caller, for errors documented as refusals. */
function joinRefusalReason(response: SlackErrorResponse): string | undefined {
  switch (response.error) {
    case "channel_not_found":
      return "no such channel is visible in this workspace; check the ID and the workspace";
    case "is_archived":
      return "the channel is archived";
    case "method_not_supported_for_channel_type":
      return "only public channels can be joined; private channels and DMs need an invite";
    case "missing_scope":
      return response.needed
        ? `the token needs ${response.needed}${response.provided ? `; it has ${response.provided}` : ""}`
        : "the token needs channels:write (user token) or channels:join (bot token)";
    case "enterprise_is_restricted":
      return "Slack does not allow conversations.join from this Enterprise Grid org or token; join the channel in the Slack client";
    case "too_many_members":
      return "the channel has reached Slack's member limit";
    case "channel_is_limited_access":
      return "the channel is a private Salesforce record channel you have no access to";
    case "app_cannot_join_channel":
      return "Slack does not let this app join the channel";
    case "team_access_not_granted":
      return "the token has not been granted access to the channel's workspace";
    case "not_allowed_token_type":
      return "Slack does not accept this kind of token for conversations.join";
    case "org_login_required":
      return "the workspace is migrating to an Enterprise Grid org and is unavailable until that finishes";
    case "account_inactive":
      return "the token belongs to a deleted user or workspace";
    default:
      return undefined;
  }
}

async function resolveChannelIdToJoin(client: SlackApiClient, channel: string): Promise<string> {
  try {
    return await resolveChannelIdIncludingArchived(client, channel);
  } catch (err: unknown) {
    if (slackErrorResponse(err)?.error === "enterprise_is_restricted") {
      const name = `#${normalizeChannelInput(channel).value}`;
      throw new Error(
        `Cannot look up ${name}: Enterprise Grid restricts channel name lookup for this token; pass the channel ID or a message URL instead`,
        { cause: err },
      );
    }
    throw err;
  }
}

export async function inviteUsersToChannel(
  client: SlackApiClient,
  input: { channelId: string; userIds: string[] },
): Promise<{ invited_user_ids: string[]; already_in_channel_user_ids: string[] }> {
  const invitedUserIds: string[] = [];
  const alreadyInChannelUserIds: string[] = [];

  for (const userId of input.userIds) {
    try {
      await client.api("conversations.invite", {
        channel: input.channelId,
        users: userId,
      });
      invitedUserIds.push(userId);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("already_in_channel")) {
        alreadyInChannelUserIds.push(userId);
        continue;
      }
      throw err;
    }
  }

  return {
    invited_user_ids: invitedUserIds,
    already_in_channel_user_ids: alreadyInChannelUserIds,
  };
}

export function parseInviteUsersCsv(input: string): string[] {
  return Array.from(
    new Set(
      asArray(input.split(","))
        .map((value) => String(value).trim())
        .filter(Boolean),
    ),
  );
}

export function splitEmailsFromInviteTargets(input: string[]): {
  emails: string[];
  non_email_targets: string[];
} {
  const emails: string[] = [];
  const nonEmailTargets: string[] = [];
  for (const target of input) {
    if (isLikelyEmail(target)) {
      emails.push(target);
      continue;
    }
    nonEmailTargets.push(target);
  }
  return {
    emails: Array.from(new Set(emails)),
    non_email_targets: nonEmailTargets,
  };
}

export async function inviteExternalUsersToChannel(
  client: SlackApiClient,
  input: { channelId: string; emails: string[]; externalLimited?: boolean },
): Promise<{ invited_emails: string[]; already_invited_emails: string[] }> {
  const invitedEmails: string[] = [];
  const alreadyInvitedEmails: string[] = [];

  for (const email of input.emails) {
    try {
      await client.api("conversations.inviteShared", {
        channel: input.channelId,
        emails: [email],
        external_limited: input.externalLimited ?? true,
      });
      invitedEmails.push(email);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("already_in_channel") || message.includes("already_invited")) {
        alreadyInvitedEmails.push(email);
        continue;
      }
      throw err;
    }
  }

  return {
    invited_emails: invitedEmails,
    already_invited_emails: alreadyInvitedEmails,
  };
}

function isLikelyEmail(input: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.trim());
}
