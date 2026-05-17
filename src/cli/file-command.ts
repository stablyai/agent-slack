import type { Command } from "commander";
import type { CliContext } from "./context.ts";
import { uploadFile } from "./file-actions.ts";

function collectOptionValue(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function registerFileCommand(input: { program: Command; ctx: CliContext }): void {
  const fileCmd = input.program.command("file").description("Upload and manage Slack files");

  fileCmd
    .command("upload")
    .description("Upload one or more files to a channel or DM")
    .argument("<target>", "Slack message URL, #name/name, channel id, or user id")
    .argument(
      "<path>",
      "Local file path to upload (repeatable via --attach)",
      collectOptionValue,
      [],
    )
    .option(
      "--workspace <url>",
      "Workspace selector (full URL or unique substring; needed when using #channel/channel id across multiple workspaces)",
    )
    .option("--thread-ts <ts>", "Thread root ts to upload into (optional)")
    .option("--comment <text>", "Initial comment to include with the upload")
    .option(
      "--attach <path>",
      "Additional file paths to upload (repeatable)",
      collectOptionValue,
      [],
    )
    .action(async (...args) => {
      const [targetInput, paths, options] = args as [
        string,
        string[],
        { workspace?: string; threadTs?: string; comment?: string; attach?: string[] },
      ];
      const allPaths = [...paths, ...(options.attach ?? [])];
      if (allPaths.length === 0) {
        console.error("Error: at least one file path is required.");
        process.exitCode = 1;
        return;
      }
      try {
        const payload = await uploadFile({
          ctx: input.ctx,
          targetInput,
          filePaths: allPaths,
          options,
        });
        console.log(JSON.stringify(payload, null, 2));
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });
}
