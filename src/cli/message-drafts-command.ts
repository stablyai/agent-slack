import type { Command } from "commander";
import type { CliContext } from "./context.ts";
import {
  createDraftAction,
  deleteDraftAction,
  listDraftsAction,
  updateDraftAction,
} from "./message-drafts-actions.ts";

export function registerMessageDraftsCommand(input: {
  messageCmd: Command;
  ctx: CliContext;
}): void {
  const draftsCmd = input.messageCmd
    .command("drafts")
    .description(
      "Manage Slack-native message drafts (show up in the user's Slack client; requires browser auth)",
    );

  draftsCmd
    .command("list", { isDefault: true })
    .description("List unsent message drafts")
    .option("--workspace <url>", "Workspace selector (full URL or unique substring)")
    .option("--limit <n>", "Max drafts to return")
    .option("--all", "Include sent/inactive drafts")
    .action(async (options: { workspace?: string; limit?: string; all?: boolean }) => {
      try {
        const payload = await listDraftsAction({ ctx: input.ctx, options });
        console.log(JSON.stringify(payload, null, 2));
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });

  draftsCmd
    .command("create")
    .description("Create a Slack-native draft addressed to a channel, DM, or thread")
    .argument("<target>", "Slack message URL (drafts a thread reply), #name/name, or channel id")
    .argument("<text>", "Draft message text (mrkdwn format)")
    .option(
      "--workspace <url>",
      "Workspace selector (full URL or unique substring; needed when using #channel/channel id across multiple workspaces)",
    )
    .option("--thread-ts <ts>", "Thread root ts to draft a reply into (optional)")
    .option(
      "--broadcast",
      "Also send the thread reply to the channel when posted (requires thread context)",
    )
    .action(async (...args) => {
      const [targetInput, text, options] = args as [
        string,
        string,
        { workspace?: string; threadTs?: string; broadcast?: boolean },
      ];
      try {
        const payload = await createDraftAction({ ctx: input.ctx, targetInput, text, options });
        console.log(JSON.stringify(payload, null, 2));
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });

  draftsCmd
    .command("update")
    .description("Replace a draft's text (and optionally re-address it)")
    .argument("<draft-id>", "Draft id returned by drafts list/create")
    .argument("<text>", "New draft message text (replaces the existing body)")
    .option(
      "--workspace <url>",
      "Workspace selector (full URL or unique substring; needed when using #channel/channel id across multiple workspaces)",
    )
    .option("--channel <target>", "Re-address the draft to a different channel/DM/message URL")
    .option("--thread-ts <ts>", "Thread root ts to draft a reply into (optional)")
    .option(
      "--broadcast",
      "Also send the thread reply to the channel when posted (requires thread context)",
    )
    .option(
      "--last-updated-ts <ts>",
      "Draft last_updated_ts for conflict detection (auto-fetched when omitted)",
    )
    .action(async (...args) => {
      const [draftId, text, options] = args as [
        string,
        string,
        {
          workspace?: string;
          channel?: string;
          threadTs?: string;
          broadcast?: boolean;
          lastUpdatedTs?: string;
        },
      ];
      try {
        const payload = await updateDraftAction({ ctx: input.ctx, draftId, text, options });
        console.log(JSON.stringify(payload, null, 2));
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });

  draftsCmd
    .command("delete")
    .description("Delete a draft")
    .argument("<draft-id>", "Draft id returned by drafts list/create")
    .option("--workspace <url>", "Workspace selector (full URL or unique substring)")
    .option(
      "--last-updated-ts <ts>",
      "Draft last_updated_ts for conflict detection (auto-fetched when omitted)",
    )
    .action(async (...args) => {
      const [draftId, options] = args as [string, { workspace?: string; lastUpdatedTs?: string }];
      try {
        const payload = await deleteDraftAction({ ctx: input.ctx, draftId, options });
        console.log(JSON.stringify(payload, null, 2));
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });
}
