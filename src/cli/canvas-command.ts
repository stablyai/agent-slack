import type { Command } from "commander";
import type { CliContext } from "./context.ts";
import { fetchCanvasMarkdown, parseSlackCanvasUrl } from "../slack/canvas.ts";
import { pruneEmpty } from "../lib/compact-json.ts";

export function registerCanvasCommand(input: { program: Command; ctx: CliContext }): void {
  const canvasCmd = input.program.command("canvas").description("Work with Slack canvases");

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
