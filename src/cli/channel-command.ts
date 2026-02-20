import type { Command } from "commander";
import type { CliContext } from "./context.ts";
import { pruneEmpty } from "../lib/compact-json.ts";
import { resolveChannelId } from "../slack/channels.ts";
import {
  createChannel,
  inviteUsersToChannel,
  parseInviteUsersCsv,
} from "../slack/channel-admin.ts";
import { resolveUserId } from "../slack/users.ts";

export function registerChannelCommand(input: { program: Command; ctx: CliContext }): void {
  const channelCmd = input.program
    .command("channel")
    .description("Create channels and invite users");

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
    .option(
      "--workspace <url>",
      "Workspace selector (full URL or unique substring; required if you have multiple workspaces)",
    )
    .action(async (...args) => {
      const [options] = args as [{ channel: string; users: string; workspace?: string }];
      try {
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
