import type { Command } from "commander";
import type { CliContext } from "./context.ts";
import { pruneEmpty } from "../lib/compact-json.ts";
import { listConversations, type ConversationType } from "../slack/conversations.ts";

const VALID_TYPES = new Set<string>(["public", "private", "group-dm", "dm"]);

function collectType(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function registerConversationCommand(input: { program: Command; ctx: CliContext }): void {
  const convCmd = input.program
    .command("conversation")
    .description("Browse workspace conversations (channels, DMs, group DMs)");

  convCmd
    .command("list")
    .description("List conversations in the workspace")
    .option(
      "--workspace <url>",
      "Workspace selector (full URL or unique substring; required if you have multiple workspaces)",
    )
    .option(
      "--type <type>",
      "Conversation type: public, private, group-dm, dm. Repeatable.",
      collectType,
      [] as string[],
    )
    .option("--limit <n>", "Max results (default 200)", "200")
    .option("--cursor <cursor>", "Pagination cursor")
    .option("--exclude-archived", "Omit archived conversations")
    .action(async (...args) => {
      const [options] = args as [
        {
          workspace?: string;
          type: string[];
          limit: string;
          cursor?: string;
          excludeArchived?: boolean;
        },
      ];
      try {
        const types = options.type.length
          ? options.type.map((t) => {
              if (!VALID_TYPES.has(t)) {
                throw new Error(
                  `Invalid --type value: "${t}". Must be one of: public, private, group-dm, dm`,
                );
              }
              return t as ConversationType;
            })
          : undefined;

        const workspaceUrl = input.ctx.effectiveWorkspaceUrl(options.workspace);
        const payload = await input.ctx.withAutoRefresh({
          workspaceUrl,
          work: async () => {
            const { client } = await input.ctx.getClientForWorkspace(workspaceUrl);
            const limit = Number.parseInt(options.limit, 10);
            return await listConversations(client, {
              types,
              limit,
              cursor: options.cursor,
              excludeArchived: Boolean(options.excludeArchived),
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
