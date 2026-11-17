import type { SlackApiClient } from "./client.ts";
import { asArray, getString, isRecord } from "../lib/object-type-guards.ts";

/**
 * On Enterprise Grid an org-level token (`auth.test` reports
 * `is_enterprise_install`) must name the workspace to create the channel in
 * via `team_id`; Slack otherwise answers `cannot_create_channel`. Returns the
 * explicit id, or the user's only workspace in the org, or throws listing the
 * candidates. Returns undefined for workspace-level tokens.
 */
export async function resolveCreateTeamId(
  client: SlackApiClient,
  explicitTeamId?: string,
): Promise<string | undefined> {
  const explicit = explicitTeamId?.trim();
  if (explicit) {
    return explicit;
  }

  const auth = await client.api("auth.test", {});
  if (auth.is_enterprise_install !== true) {
    return undefined;
  }

  const userId = getString(auth.user_id);
  const info = userId ? await client.api("users.info", { user: userId }) : {};
  const enterpriseUser =
    isRecord(info.user) && isRecord(info.user.enterprise_user) ? info.user.enterprise_user : null;
  const teamIds = enterpriseUser
    ? asArray(enterpriseUser.teams).filter((t): t is string => typeof t === "string")
    : [];

  if (teamIds.length === 1) {
    return teamIds[0];
  }

  const labels = await Promise.all(
    teamIds.map(async (id) => {
      try {
        const resp = await client.api("team.info", { team: id });
        const name = isRecord(resp.team) ? getString(resp.team.name) : undefined;
        return name ? `${id} (${name})` : id;
      } catch {
        return id;
      }
    }),
  );
  const choices = labels.length > 0 ? `one of: ${labels.join(", ")}` : "team id starts with T";
  throw new Error(
    `This is an Enterprise Grid org-level session: pass --team <team-id> to choose the workspace (${choices})`,
  );
}

export async function createChannel(
  client: SlackApiClient,
  input: { name: string; isPrivate?: boolean; teamId?: string },
): Promise<{ channel: { id: string; name: string; is_private: boolean } }> {
  const name = input.name.trim();
  if (!name) {
    throw new Error("Channel name is empty");
  }

  const teamId = await resolveCreateTeamId(client, input.teamId);
  const resp = await client.api("conversations.create", {
    name,
    is_private: Boolean(input.isPrivate),
    ...(teamId ? { team_id: teamId } : {}),
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
