import type { Command } from "commander";
import type { CliContext } from "./context.ts";
import {
  setLaterReminder,
  fetchLaterItems,
  parseReminderDuration,
  removeLater,
  saveLater,
  updateLaterMark,
} from "../slack/later.ts";
import { pruneEmpty } from "../lib/compact-json.ts";
import { parseMsgTarget } from "./targets.ts";
import { resolveChannelId } from "../slack/channels.ts";

function resolveTargetRef(input: {
  targetInput: string;
  options: { workspace?: string; ts?: string };
  ctx: CliContext;
}): {
  getChannelAndTs: (client: {
    api: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  }) => Promise<{ channelId: string; ts: string }>;
  workspaceUrl: string | undefined;
} {
  const { targetInput, options, ctx } = input;
  const target = parseMsgTarget(targetInput);

  if (target.kind === "url") {
    return {
      workspaceUrl: target.ref.workspace_url,
      getChannelAndTs: async () => ({
        channelId: target.ref.channel_id,
        ts: target.ref.message_ts,
      }),
    };
  }

  const workspaceUrl = ctx.effectiveWorkspaceUrl(options.workspace);
  const ts = options.ts?.trim();
  if (!ts) {
    throw new Error('When targeting a channel, you must pass --ts "<seconds>.<micros>"');
  }

  return {
    workspaceUrl,
    getChannelAndTs: async (client) => {
      const channelId = await resolveChannelId(
        client as Parameters<typeof resolveChannelId>[0],
        target.kind === "channel" ? target.channel : targetInput,
      );
      return { channelId, ts };
    },
  };
}

export function registerLaterCommand(input: { program: Command; ctx: CliContext }): void {
  const laterCmd = input.program
    .command("later")
    .description("Manage saved-for-later messages (Slack's Later tab)");

  laterCmd
    .command("list", { isDefault: true })
    .description("List saved-for-later messages")
    .option("--workspace <url>", "Workspace URL (defaults to your configured workspace)")
    .option(
      "--state <state>",
      "Filter by state: in_progress (default), archived, completed, all",
      "in_progress",
    )
    .option("--limit <n>", "Max items to show (default 20)", "20")
    .option(
      "--max-body-chars <n>",
      "Max content characters per message (default 4000, -1 for unlimited)",
      "4000",
    )
    .option("--counts-only", "Only show counts per state, skip message content")
    .action(
      async (options: {
        workspace?: string;
        state?: string;
        limit?: string;
        maxBodyChars?: string;
        countsOnly?: boolean;
      }) => {
        try {
          const workspaceUrl = input.ctx.effectiveWorkspaceUrl(options.workspace);
          const state = parseState(options.state ?? "in_progress");

          const payload = await input.ctx.withAutoRefresh({
            workspaceUrl,
            work: async () => {
              const { client } = await input.ctx.getClientForWorkspace(workspaceUrl);
              return fetchLaterItems(client, {
                state,
                limit: Number.parseInt(options.limit ?? "20", 10),
                maxBodyChars: Number.parseInt(options.maxBodyChars ?? "4000", 10),
                countsOnly: options.countsOnly,
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

  laterCmd
    .command("complete")
    .description("Mark a saved message as completed")
    .argument("<target>", "Slack message URL or channel ID")
    .option("--workspace <url>", "Workspace URL")
    .option("--ts <ts>", "Message ts (required when using channel ID)")
    .action(async (...args) => {
      const [targetInput, options] = args as [string, { workspace?: string; ts?: string }];
      try {
        const ref = resolveTargetRef({ targetInput, options, ctx: input.ctx });
        await input.ctx.withAutoRefresh({
          workspaceUrl: ref.workspaceUrl,
          work: async () => {
            const { client } = await input.ctx.getClientForWorkspace(ref.workspaceUrl);
            const { channelId, ts } = await ref.getChannelAndTs(client);
            await updateLaterMark(client, { channelId, ts, mark: "completed" });
          },
        });
        console.log(JSON.stringify({ ok: true }));
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });

  laterCmd
    .command("archive")
    .description("Archive a saved message")
    .argument("<target>", "Slack message URL or channel ID")
    .option("--workspace <url>", "Workspace URL")
    .option("--ts <ts>", "Message ts (required when using channel ID)")
    .action(async (...args) => {
      const [targetInput, options] = args as [string, { workspace?: string; ts?: string }];
      try {
        const ref = resolveTargetRef({ targetInput, options, ctx: input.ctx });
        await input.ctx.withAutoRefresh({
          workspaceUrl: ref.workspaceUrl,
          work: async () => {
            const { client } = await input.ctx.getClientForWorkspace(ref.workspaceUrl);
            const { channelId, ts } = await ref.getChannelAndTs(client);
            await updateLaterMark(client, { channelId, ts, mark: "archived" });
          },
        });
        console.log(JSON.stringify({ ok: true }));
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });

  laterCmd
    .command("reopen")
    .description("Move a saved message back to in-progress")
    .argument("<target>", "Slack message URL or channel ID")
    .option("--workspace <url>", "Workspace URL")
    .option("--ts <ts>", "Message ts (required when using channel ID)")
    .action(async (...args) => {
      const [targetInput, options] = args as [string, { workspace?: string; ts?: string }];
      try {
        const ref = resolveTargetRef({ targetInput, options, ctx: input.ctx });
        await input.ctx.withAutoRefresh({
          workspaceUrl: ref.workspaceUrl,
          work: async () => {
            const { client } = await input.ctx.getClientForWorkspace(ref.workspaceUrl);
            const { channelId, ts } = await ref.getChannelAndTs(client);
            // Try both uncompleted and unarchived since we don't know current state
            await Promise.allSettled([
              updateLaterMark(client, { channelId, ts, mark: "uncompleted" }),
              updateLaterMark(client, { channelId, ts, mark: "unarchived" }),
            ]);
          },
        });
        console.log(JSON.stringify({ ok: true }));
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });

  laterCmd
    .command("save")
    .description("Save a message for later")
    .argument("<target>", "Slack message URL or channel ID")
    .option("--workspace <url>", "Workspace URL")
    .option("--ts <ts>", "Message ts (required when using channel ID)")
    .action(async (...args) => {
      const [targetInput, options] = args as [string, { workspace?: string; ts?: string }];
      try {
        const ref = resolveTargetRef({ targetInput, options, ctx: input.ctx });
        await input.ctx.withAutoRefresh({
          workspaceUrl: ref.workspaceUrl,
          work: async () => {
            const { client } = await input.ctx.getClientForWorkspace(ref.workspaceUrl);
            const { channelId, ts } = await ref.getChannelAndTs(client);
            await saveLater(client, { channelId, ts });
          },
        });
        console.log(JSON.stringify({ ok: true }));
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });

  laterCmd
    .command("remove")
    .description("Remove a message from Later entirely")
    .argument("<target>", "Slack message URL or channel ID")
    .option("--workspace <url>", "Workspace URL")
    .option("--ts <ts>", "Message ts (required when using channel ID)")
    .action(async (...args) => {
      const [targetInput, options] = args as [string, { workspace?: string; ts?: string }];
      try {
        const ref = resolveTargetRef({ targetInput, options, ctx: input.ctx });
        await input.ctx.withAutoRefresh({
          workspaceUrl: ref.workspaceUrl,
          work: async () => {
            const { client } = await input.ctx.getClientForWorkspace(ref.workspaceUrl);
            const { channelId, ts } = await ref.getChannelAndTs(client);
            await removeLater(client, { channelId, ts });
          },
        });
        console.log(JSON.stringify({ ok: true }));
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });

  laterCmd
    .command("remind")
    .description("Set a reminder for a saved message")
    .argument("<target>", "Slack message URL or channel ID")
    .requiredOption("--in <duration>", "When to remind: 30m, 1h, 3h, 2d, tomorrow, monday, etc.")
    .option("--workspace <url>", "Workspace URL")
    .option("--ts <ts>", "Message ts (required when using channel ID)")
    .action(async (...args) => {
      const [targetInput, options] = args as [
        string,
        { in: string; workspace?: string; ts?: string },
      ];
      try {
        const ref = resolveTargetRef({ targetInput, options, ctx: input.ctx });
        const reminderTime = parseReminderDuration(options.in);

        await input.ctx.withAutoRefresh({
          workspaceUrl: ref.workspaceUrl,
          work: async () => {
            const { client } = await input.ctx.getClientForWorkspace(ref.workspaceUrl);
            const { channelId, ts } = await ref.getChannelAndTs(client);
            await setLaterReminder(client, { channelId, ts, dateDue: reminderTime });
          },
        });

        console.log(
          JSON.stringify({
            ok: true,
            remind_at: reminderTime,
          }),
        );
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });
}

function parseState(value: string): "in_progress" | "archived" | "completed" | "all" {
  const v = value.toLowerCase().trim();
  if (v === "in_progress" || v === "in-progress" || v === "active" || v === "open") {
    return "in_progress";
  }
  if (v === "archived" || v === "archive") {
    return "archived";
  }
  if (v === "completed" || v === "complete" || v === "done") {
    return "completed";
  }
  if (v === "all") {
    return "all";
  }
  return "in_progress";
}
