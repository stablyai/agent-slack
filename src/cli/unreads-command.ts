import type { Command } from "commander";
import type { CliContext } from "./context.ts";
import { fetchUnreads } from "../slack/unreads.ts";
import { pruneEmpty } from "../lib/compact-json.ts";

export function registerUnreadsCommand(input: { program: Command; ctx: CliContext }): void {
  input.program
    .command("unreads")
    .description("Show all unread messages across channels, DMs, and threads")
    .option("--workspace <url>", "Workspace URL (defaults to your configured workspace)")
    .option("--counts-only", "Only show unread counts, do not fetch message content")
    .option("--max-messages <n>", "Max unread messages to fetch per channel (default 10)", "10")
    .option(
      "--max-body-chars <n>",
      "Max content characters per message (default 4000, -1 for unlimited)",
      "4000",
    )
    .option("--include-system", "Include system messages (joins, leaves, topic changes, etc.)")
    .action(
      async (options: {
        workspace?: string;
        countsOnly?: boolean;
        maxMessages?: string;
        maxBodyChars?: string;
        includeSystem?: boolean;
      }) => {
        try {
          const workspaceUrl = input.ctx.effectiveWorkspaceUrl(options.workspace);

          const payload = await input.ctx.withAutoRefresh({
            workspaceUrl,
            work: async () => {
              const { client } = await input.ctx.getClientForWorkspace(workspaceUrl);
              return fetchUnreads(client, {
                includeMessages: !options.countsOnly,
                maxMessagesPerChannel: Number.parseInt(options.maxMessages ?? "10", 10),
                maxBodyChars: Number.parseInt(options.maxBodyChars ?? "4000", 10),
                skipSystemMessages: !options.includeSystem,
              });
            },
          });

          console.log(JSON.stringify(pruneEmpty(payload), null, 2));
        } catch (err: unknown) {
          console.error(input.ctx.errorMessage(err));
          process.exitCode = 1;
        }
      },
    );
}
