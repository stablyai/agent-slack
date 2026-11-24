import type { Command } from "commander";
import type { CliContext } from "./context.ts";
import { handleMessageWatch, type MessageWatchOptions } from "./message-watch-handler.ts";

export function registerMessageWatchCommand(input: { messageCmd: Command; ctx: CliContext }): void {
  input.messageCmd
    .command("watch")
    .description(
      "Follow threads or whole conversations (DMs, channels): report new, edited and deleted messages as one JSON line per batch until --once or --timeout",
    )
    .argument(
      "<targets...>",
      "Message URLs (follow that thread), or DM/channel IDs, #channels or user IDs (follow the whole conversation, including new thread replies)",
    )
    .option(
      "--workspace <url>",
      "Workspace selector (full URL or unique substring; needed when using #channel/channel id across multiple workspaces)",
    )
    .option(
      "--thread-ts <ts>",
      "Follow this thread instead of the whole conversation (single channel target)",
    )
    .option("--ts <ts>", "Message ts, resolved to its thread (single channel target)")
    .option(
      "--since <ts>",
      "Start fresh and report replies after this ts (default: resume saved state, else from now)",
    )
    .option("--once", "Exit after the first batch (for a background task that wakes an agent)")
    .option("--timeout <duration>", "Exit after this long, e.g. 30m, 2h, 1d (default: none)")
    .option("--interval <duration>", "Poll interval while active, e.g. 15s, 1m (min 5s)", "15s")
    .option("--max-interval <duration>", "Poll interval ceiling while threads are quiet", "2m")
    .option(
      "--settle <duration>",
      "Quiet time after a change before reporting, so a burst is one batch (0 = report at once)",
      "15s",
    )
    .option("--no-edits", "Report only new replies (incremental reads; skips edit/delete tracking)")
    .option(
      "--include-self",
      "Also report your own API-posted changes (agent-slack sends/edits); ones you make in Slack always report",
    )
    .option("--fresh", "Ignore saved state and start from now")
    .option("--no-state", "Neither read nor write saved state")
    .option(
      "--max-body-chars <n>",
      "Max content characters to include (default 8000, -1 for unlimited)",
      "8000",
    )
    .action(async (...args) => {
      const [targets, options] = args as [string[], MessageWatchOptions];
      try {
        await handleMessageWatch({
          ctx: input.ctx,
          targets,
          options,
          writeLine: (line) => console.log(line),
          writeError: (line) => console.error(line),
        });
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });
}
