import type { Command } from "commander";
import type { CliContext } from "./context.ts";
import { pruneEmpty } from "../lib/compact-json.ts";
import { listAllConversations, listUserConversations } from "../slack/channels.ts";
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
    .description("List Slack channels/conversations");

  channelCmd
    .command("list")
    .description("List conversations for a user (or current user), or all conversations")
    .option("--workspace <url>", "Workspace URL (required if you have multiple workspaces)")
    .option("--user <user>", "User id (U...) or @handle/handle")
    .option("--all", "List all conversations (calls conversations.list, incompatible with --user)")
    .option("--limit <n>", "Max conversations in one page (default 200)", "200")
    .option("--cursor <cursor>", "Pagination cursor")
    .action(async (...args) => {
      const [options] = args as [ChannelListOptions];
      try {
        if (options.all && options.user) {
          throw new Error("--all cannot be used with --user");
        }

        const workspaceUrl = input.ctx.effectiveWorkspaceUrl(options.workspace);
        const limit = Number.parseInt(options.limit, 10);
        if (Number.isNaN(limit)) {
          throw new Error(`Invalid --limit value: ${options.limit}`);
        }

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
              const resolved = await resolveUserId(client, options.user);
              if (!resolved) {
                throw new Error(`Could not resolve user: ${options.user}`);
              }
              userId = resolved;
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
}
