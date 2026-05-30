import type { Command } from "commander";
import type { CliContext } from "./context.ts";
import { cancelScheduledMessage, listScheduledMessages } from "./message-scheduled-actions.ts";

export function registerScheduledMessageCommand(input: {
  messageCmd: Command;
  ctx: CliContext;
}): void {
  const scheduledCmd = input.messageCmd
    .command("scheduled")
    .description("List or cancel pending scheduled messages");

  scheduledCmd
    .command("list", { isDefault: true })
    .description("List pending scheduled messages")
    .option("--workspace <url>", "Workspace selector (full URL or unique substring)")
    .option("--channel <channel>", "Limit to a channel/DM id or channel name")
    .option("--oldest <ts>", "Only messages scheduled after this Unix timestamp")
    .option("--latest <ts>", "Only messages scheduled before this Unix timestamp")
    .option("--cursor <cursor>", "Fetch the next page from chat.scheduledMessages.list")
    .option("--limit <n>", "Max scheduled messages to return")
    .action(
      async (options: {
        workspace?: string;
        channel?: string;
        oldest?: string;
        latest?: string;
        cursor?: string;
        limit?: string;
      }) => {
        try {
          const payload = await listScheduledMessages({ ctx: input.ctx, options });
          console.log(JSON.stringify(payload, null, 2));
        } catch (err: unknown) {
          console.error(input.ctx.errorMessage(err));
          process.exitCode = 1;
        }
      },
    );

  scheduledCmd
    .command("cancel")
    .description("Cancel a pending scheduled message")
    .argument("<id>", "scheduled_message_id returned by message send --schedule")
    .requiredOption(
      "--channel <channel>",
      "Channel/DM id or channel name for the scheduled message",
    )
    .option("--workspace <url>", "Workspace selector (full URL or unique substring)")
    .action(async (...args) => {
      const [scheduledMessageId, options] = args as [
        string,
        { workspace?: string; channel: string },
      ];
      try {
        const payload = await cancelScheduledMessage({
          ctx: input.ctx,
          scheduledMessageId,
          options,
        });
        console.log(JSON.stringify(payload, null, 2));
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });
}
