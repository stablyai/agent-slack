import type { SlackApiClient } from "./client.ts";
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
