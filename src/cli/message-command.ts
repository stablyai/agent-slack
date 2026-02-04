import type { Command } from "commander";
import type { CliContext } from "./context.ts";
import {
  handleMessageGet,
  handleMessageList,
  reactOnTarget,
  sendMessage,
  type MessageCommandOptions,
} from "./message-actions.ts";

export function registerMessageCommand(input: { program: Command; ctx: CliContext }): void {
  const messageCmd = input.program
    .command("message")
    .description("Read/write Slack messages (token-efficient JSON)");

  messageCmd
    .command("get", { isDefault: true })
    .description("Fetch a single Slack message (with thread summary if any)")
    .argument("<target>", "Slack message URL, #channel, or channel ID")
    .option(
      "--workspace <url>",
      "Workspace URL (needed when using #channel/channel id and you have multiple workspaces)",
    )
    .option("--ts <ts>", "Message ts (required when using #channel/channel id)")
    .option("--thread-ts <ts>", "Thread root ts hint (useful for thread permalinks)")
    .option(
      "--max-body-chars <n>",
      "Max content characters to include (default 8000, -1 for unlimited)",
      "8000",
    )
    .option("--include-reactions", "Include reactions + reacting users")
    .action(async (...args) => {
      const [targetInput, options] = args as [string, MessageCommandOptions];
      try {
        const payload = await handleMessageGet({ ctx: input.ctx, targetInput, options });
        console.log(JSON.stringify(payload, null, 2));
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });

  messageCmd
    .command("list")
    .description("Fetch the full thread for a Slack message URL")
    .argument("<target>", "Slack message URL, #channel, or channel ID")
    .option(
      "--workspace <url>",
      "Workspace URL (needed when using #channel/channel id and you have multiple workspaces)",
    )
    .option(
      "--thread-ts <ts>",
      "Thread root ts (required when using #channel/channel id unless you pass --ts)",
    )
    .option("--ts <ts>", "Message ts (optional: resolve message to its thread)")
    .option(
      "--max-body-chars <n>",
      "Max content characters to include (default 8000, -1 for unlimited)",
      "8000",
    )
    .option("--include-reactions", "Include reactions + reacting users")
    .action(async (...args) => {
      const [targetInput, options] = args as [string, MessageCommandOptions];
      try {
        const payload = await handleMessageList({ ctx: input.ctx, targetInput, options });
        console.log(JSON.stringify(payload, null, 2));
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });

  messageCmd
    .command("send")
    .description("Send a message (optionally into a thread)")
    .argument("<target>", "Slack message URL, #name/name, or channel id")
    .argument("<text>", "Message text to post")
    .option(
      "--workspace <url>",
      "Workspace URL (needed when using #channel/channel id and you have multiple workspaces)",
    )
    .option("--thread-ts <ts>", "Thread root ts to post into (optional)")
    .action(async (...args) => {
      const [targetInput, text, options] = args as [
        string,
        string,
        { workspace?: string; threadTs?: string },
      ];
      try {
        const payload = await sendMessage({
          ctx: input.ctx,
          targetInput,
          text,
          options,
        });
        console.log(JSON.stringify(payload, null, 2));
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });

  const reactCmd = messageCmd.command("react").description("Add or remove reactions");

  reactCmd
    .command("add")
    .description("Add a reaction to a message")
    .argument("<target>", "Slack message URL, #channel, or channel ID")
    .argument("<emoji>", "Emoji to react with (:rocket:, rocket, or 🚀)")
    .option(
      "--workspace <url>",
      "Workspace URL (needed when using #channel/channel id and you have multiple workspaces)",
    )
    .option("--ts <ts>", "Message ts (required when using #channel/channel id)")
    .action(async (...args) => {
      const [targetInput, emoji, options] = args as [
        string,
        string,
        { workspace?: string; ts?: string },
      ];
      try {
        const payload = await reactOnTarget({
          ctx: input.ctx,
          action: "add",
          targetInput,
          emoji,
          options,
        });
        console.log(JSON.stringify(payload, null, 2));
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });

  reactCmd
    .command("remove")
    .description("Remove a reaction from a message")
    .argument("<target>", "Slack message URL, #channel, or channel ID")
    .argument("<emoji>", "Emoji to remove (:rocket:, rocket, or 🚀)")
    .option(
      "--workspace <url>",
      "Workspace URL (needed when using #channel/channel id and you have multiple workspaces)",
    )
    .option("--ts <ts>", "Message ts (required when using #channel/channel id)")
    .action(async (...args) => {
      const [targetInput, emoji, options] = args as [
        string,
        string,
        { workspace?: string; ts?: string },
      ];
      try {
        const payload = await reactOnTarget({
          ctx: input.ctx,
          action: "remove",
          targetInput,
          emoji,
          options,
        });
        console.log(JSON.stringify(payload, null, 2));
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });
}
