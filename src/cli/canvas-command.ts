import type { Command } from "commander";
import type { CliContext } from "./context.ts";
import {
  BROWSER_AUTH_CANVAS_CHANNEL_ERROR,
  createCanvasFromMarkdown,
  fetchCanvasMarkdown,
  parseSlackCanvasUrl,
} from "../slack/canvas.ts";
import { pruneEmpty } from "../lib/compact-json.ts";
import { resolveChannelId } from "../slack/channels.ts";
import { readFile } from "node:fs/promises";

type CanvasCreateOptions = {
  file?: string;
  markdown?: string;
  title?: string;
  channel?: string;
  workspace?: string;
};

export async function readCanvasMarkdownInput(options: {
  file?: string;
  markdown?: string;
}): Promise<string> {
  const hasFile = options.file !== undefined;
  const hasMarkdown = options.markdown !== undefined;
  if (hasFile === hasMarkdown) {
    throw new Error("Pass exactly one Markdown source: --file <path> or --markdown <text>");
  }

  let markdown: string;
  if (hasFile) {
    try {
      markdown = await readFile(options.file!, "utf8");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not read Markdown file "${options.file}": ${message}`);
    }
  } else {
    markdown = options.markdown!;
  }

  if (!markdown.trim()) {
    throw new Error("Canvas Markdown is empty");
  }
  return markdown;
}

export function registerCanvasCommand(input: { program: Command; ctx: CliContext }): void {
  const canvasCmd = input.program.command("canvas").description("Work with Slack canvases");

  canvasCmd
    .command("create")
    .description("Create a Slack canvas from exactly one Markdown source")
    .option("--file <path>", "Read Markdown from a local file; mutually exclusive with --markdown")
    .option("--markdown <text>", "Use a Markdown string; mutually exclusive with --file")
    .option("--title <title>", "Canvas title")
    .option(
      "--channel <id-or-name>",
      "Add as a channel tab (required on free Slack plans; requires a standard token with canvases:write; browser auth supports standalone canvases only)",
    )
    .option(
      "--workspace <url>",
      "Workspace selector (full URL or unique substring; required if you have multiple workspaces)",
    )
    .action(async (...args) => {
      const [options] = args as [CanvasCreateOptions];
      try {
        const markdown = await readCanvasMarkdownInput(options);
        const workspaceUrl = input.ctx.effectiveWorkspaceUrl(options.workspace);
        if (options.channel) {
          await input.ctx.assertWorkspaceSpecifiedForChannelNames({
            workspaceUrl,
            channels: [options.channel],
          });
        }

        const payload = await input.ctx.withAutoRefresh({
          workspaceUrl,
          work: async () => {
            const { client, auth } = await input.ctx.getClientForWorkspace(workspaceUrl);
            if (options.channel && auth.auth_type === "browser") {
              throw new Error(BROWSER_AUTH_CANVAS_CHANNEL_ERROR);
            }
            const channelId = options.channel
              ? await resolveChannelId(client, options.channel)
              : undefined;
            return await createCanvasFromMarkdown(client, {
              auth,
              markdown,
              title: options.title,
              channelId,
            });
          },
        });

        console.log(JSON.stringify(pruneEmpty(payload), null, 2));
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });

  canvasCmd
    .command("get")
    .description("Fetch a Slack canvas and convert it to Markdown")
    .argument("<canvas>", "Slack canvas URL (…/docs/…/F…) or canvas id (F…)")
    .option(
      "--workspace <url>",
      "Workspace selector (full URL or unique substring; required if passing a canvas id across multiple workspaces)",
    )
    .option(
      "--max-chars <n>",
      "Max markdown characters to include (default 20000, -1 for unlimited)",
      "20000",
    )
    .action(async (...args) => {
      const [value, options] = args as [string, { workspace?: string; maxChars: string }];
      try {
        let workspaceUrl: string | undefined;
        let canvasId: string;

        try {
          const ref = parseSlackCanvasUrl(value);
          workspaceUrl = ref.workspace_url;
          canvasId = ref.canvas_id;
        } catch {
          const trimmed = String(value).trim();
          if (!/^F[A-Z0-9]{8,}$/.test(trimmed)) {
            throw new Error(
              `Unsupported canvas input: ${value} (expected Slack canvas URL or id like F...)`,
            );
          }
          canvasId = trimmed;
          workspaceUrl = options.workspace?.trim() || undefined;
        }

        const payload = await input.ctx.withAutoRefresh({
          workspaceUrl,
          work: async () => {
            const { client, auth, workspace_url } =
              await input.ctx.getClientForWorkspace(workspaceUrl);
            const maxChars = Number.parseInt(options.maxChars, 10);
            return await fetchCanvasMarkdown(client, {
              auth,
              workspaceUrl: workspace_url ?? workspaceUrl ?? "",
              canvasId,
              options: { maxChars },
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
