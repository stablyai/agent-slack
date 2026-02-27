import type { Command } from "commander";
import type { CliContext } from "./context.ts";
import { pruneEmpty } from "../lib/compact-json.ts";
import {
  listAllConversations,
  listUserConversations,
  resolveChannelId,
} from "../slack/channels.ts";
import {
  createChannel,
  inviteExternalUsersToChannel,
  inviteUsersToChannel,
  parseInviteUsersCsv,
  splitEmailsFromInviteTargets,
} from "../slack/channel-admin.ts";
import { resolveUserId } from "../slack/users.ts";

type ChannelListOptions = {
  workspace?: string;
  user?: string;
  all?: boolean;
  limit: string;
  cursor?: string;
};

export function registerChannelCommand(input: { program: Command; ctx: CliContext }): void {
  const channelCmd = input.program
    .command("channel")
    .description("List conversations, create channels, and manage invites");

  channelCmd
    .command("list")
    .description("List conversations for a user (or current user), or all conversations")
    .option(
      "--workspace <url>",
      "Workspace selector (full URL or unique substring; required if you have multiple workspaces)",
    )
    .option("--user <user>", "User id (U...) or @handle/handle")
    .option("--all", "List all conversations (conversations.list); incompatible with --user")
    .option("--limit <n>", "Max conversations in one page (default 100)", "100")
    .option("--cursor <cursor>", "Pagination cursor for the next page")
    .action(async (...args) => {
      const [options] = args as [ChannelListOptions];
      try {
        if (options.all && options.user) {
          throw new Error("--all cannot be used with --user");
        }

        const limit = Number.parseInt(options.limit, 10);
        if (!Number.isFinite(limit) || limit < 1) {
          throw new Error(`Invalid --limit value "${options.limit}": must be a positive integer`);
        }

        const workspaceUrl = input.ctx.effectiveWorkspaceUrl(options.workspace);
        const payload = await input.ctx.withAutoRefresh({
          workspaceUrl,
          work: async () => {
            const { client } = await input.ctx.getClientForWorkspace(workspaceUrl);
            if (options.all) {
              return await listAllConversations(client, {
                limit,
                cursor: options.cursor,
                excludeArchived: true,
              });
            }

            let userId: string | undefined;
            if (options.user) {
              const resolvedUserId = await resolveUserId(client, options.user);
              if (!resolvedUserId) {
                throw new Error(`Could not resolve user: ${options.user}`);
              }
              userId = resolvedUserId;
            }

            return await listUserConversations(client, {
              user: userId,
              limit,
              cursor: options.cursor,
              excludeArchived: true,
            });
          },
        });

        console.log(JSON.stringify(pruneEmpty(payload), null, 2));
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });

  channelCmd
    .command("new")
    .description("Create a new channel")
    .requiredOption("--name <name>", "Channel name")
    .option("--private", "Create as a private channel")
    .option(
      "--workspace <url>",
      "Workspace selector (full URL or unique substring; required if you have multiple workspaces)",
    )
    .action(async (...args) => {
      const [options] = args as [{ name: string; private?: boolean; workspace?: string }];
      try {
        const workspaceUrl = input.ctx.effectiveWorkspaceUrl(options.workspace);
        const payload = await input.ctx.withAutoRefresh({
          workspaceUrl,
          work: async () => {
            const { client } = await input.ctx.getClientForWorkspace(workspaceUrl);
            return await createChannel(client, {
              name: options.name,
              isPrivate: Boolean(options.private),
            });
          },
        });
        console.log(JSON.stringify(pruneEmpty(payload), null, 2));
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });

  channelCmd
    .command("invite")
    .description("Invite users to a channel")
    .requiredOption("--channel <id-or-name>", "Channel id/name (#general, general, C...)")
    .requiredOption("--users <users>", "Comma-separated users (U..., @handle, handle, email)")
    .option("--external", "Send Slack Connect external invites (email targets only)")
    .option(
      "--allow-external-user-invites",
      "For --external invites, allow invitees to invite additional users",
    )
    .option(
      "--workspace <url>",
      "Workspace selector (full URL or unique substring; required if you have multiple workspaces)",
    )
    .action(async (...args) => {
      const [options] = args as [
        {
          channel: string;
          users: string;
          external?: boolean;
          allowExternalUserInvites?: boolean;
          workspace?: string;
        },
      ];
      try {
        if (options.allowExternalUserInvites && !options.external) {
          throw new Error("--allow-external-user-invites requires --external");
        }

        const workspaceUrl = input.ctx.effectiveWorkspaceUrl(options.workspace);
        await input.ctx.assertWorkspaceSpecifiedForChannelNames({
          workspaceUrl,
          channels: [options.channel],
        });

        const userInputs = parseInviteUsersCsv(options.users);
        if (userInputs.length === 0) {
          throw new Error('No users provided. Pass --users "U01...,@alice,bob@example.com"');
        }

        const payload = await input.ctx.withAutoRefresh({
          workspaceUrl,
          work: async () => {
            const { client } = await input.ctx.getClientForWorkspace(workspaceUrl);
            const channelId = await resolveChannelId(client, options.channel);

            if (options.external) {
              const split = splitEmailsFromInviteTargets(userInputs);
              if (split.emails.length === 0) {
                throw new Error(
                  'External invites require email targets in --users, e.g. --users "alice@example.com,bob@example.com"',
                );
              }
              const externalLimited = !options.allowExternalUserInvites;
              const inviteResult = await inviteExternalUsersToChannel(client, {
                channelId,
                emails: split.emails,
                externalLimited,
              });
              return {
                channel_id: channelId,
                external: true,
                external_limited: externalLimited,
                invited_emails: inviteResult.invited_emails,
                already_invited_emails: inviteResult.already_invited_emails,
                invalid_external_targets: split.non_email_targets,
              };
            }

            const resolvedUserIds: string[] = [];
            const unresolvedUsers: string[] = [];
            for (const userInput of userInputs) {
              const userId = await resolveUserId(client, userInput);
              if (!userId) {
                unresolvedUsers.push(userInput);
                continue;
              }
              resolvedUserIds.push(userId);
            }

            const inviteResult = await inviteUsersToChannel(client, {
              channelId,
              userIds: resolvedUserIds,
            });
            return {
              channel_id: channelId,
              invited_user_ids: inviteResult.invited_user_ids,
              already_in_channel_user_ids: inviteResult.already_in_channel_user_ids,
              unresolved_users: unresolvedUsers,
            };
          },
        });
        console.log(JSON.stringify(pruneEmpty(payload), null, 2));
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });
}
