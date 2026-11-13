import { readFileSync } from "node:fs";
import type { Command } from "commander";
import type { CliContext } from "./context.ts";
import { collectOptionValue } from "./options.ts";
import { pruneEmpty } from "../lib/compact-json.ts";
import { resolveChannelId } from "../slack/channels.ts";
import { runWorkflow } from "../slack/workflow-run.ts";
import { getWorkflowSchema, listChannelWorkflows, previewWorkflow } from "../slack/workflows.ts";

type WorkspaceOption = {
  workspace?: string;
};

export function registerWorkflowCommand(input: { program: Command; ctx: CliContext }): void {
  const workflowCmd = input.program
    .command("workflow")
    .description("Discover and interact with Slack workflows");

  workflowCmd
    .command("list")
    .description("List workflows bookmarked or featured in a channel")
    .argument("<channel>", "Channel id or name (#channel, channel, C...)")
    .option(
      "--workspace <url>",
      "Workspace selector (full URL or unique substring; required if you have multiple workspaces)",
    )
    .action(async (...args) => {
      const [channel, options] = args as [string, WorkspaceOption];
      try {
        const workspaceUrl = input.ctx.effectiveWorkspaceUrl(options.workspace);
        const payload = await input.ctx.withAutoRefresh({
          workspaceUrl,
          work: async () => {
            const { client } = await input.ctx.getClientForWorkspace(workspaceUrl);
            const channelId = await resolveChannelId(client, channel);
            return await listChannelWorkflows(client, channelId);
          },
        });
        console.log(JSON.stringify(pruneEmpty(payload), null, 2));
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });

  workflowCmd
    .command("preview")
    .description("Get workflow metadata from a trigger ID (no side effects)")
    .argument("<trigger-id>", "Trigger ID (Ft...)")
    .option(
      "--workspace <url>",
      "Workspace selector (full URL or unique substring; required if you have multiple workspaces)",
    )
    .action(async (...args) => {
      const [triggerId, options] = args as [string, WorkspaceOption];
      try {
        const workspaceUrl = input.ctx.effectiveWorkspaceUrl(options.workspace);
        const payload = await input.ctx.withAutoRefresh({
          workspaceUrl,
          work: async () => {
            const { client } = await input.ctx.getClientForWorkspace(workspaceUrl);
            return await previewWorkflow(client, triggerId);
          },
        });
        console.log(JSON.stringify(pruneEmpty(payload), null, 2));
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });

  workflowCmd
    .command("get")
    .description("Get workflow definition including form fields and steps (accepts Ft... or Wf...)")
    .argument("<id>", "Trigger ID (Ft...) or Workflow ID (Wf...)")
    .option(
      "--workspace <url>",
      "Workspace selector (full URL or unique substring; required if you have multiple workspaces)",
    )
    .action(async (...args) => {
      const [id, options] = args as [string, WorkspaceOption];
      try {
        const workspaceUrl = input.ctx.effectiveWorkspaceUrl(options.workspace);
        const payload = await input.ctx.withAutoRefresh({
          workspaceUrl,
          work: async () => {
            const { client } = await input.ctx.getClientForWorkspace(workspaceUrl);
            let workflowId = id;
            if (id.startsWith("Ft")) {
              const preview = await previewWorkflow(client, id);
              workflowId = preview.workflow.id;
            }
            return await getWorkflowSchema(client, workflowId);
          },
        });
        console.log(JSON.stringify(pruneEmpty(payload), null, 2));
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });

  workflowCmd
    .command("run")
    .description(
      "Trip a workflow trigger and, if it opens a form, fill in and submit it (use --dry-run to preview)",
    )
    .argument("<trigger-id>", "Trigger ID (Ft...)")
    .option("--channel <id-or-name>", "Channel where the workflow is shown (optional context)")
    .option(
      "--input <field=value>",
      "Form field value, matched by field title (case-insensitive) or name; repeatable. Dropdowns take the option label",
      collectOptionValue,
      [],
    )
    .option("--inputs-json <file>", "JSON file (or - for stdin) mapping field title/name to value")
    .option("--dry-run", "Resolve and print the form payload without running the workflow")
    .option(
      "--workspace <url>",
      "Workspace selector (full URL or unique substring; required if you have multiple workspaces)",
    )
    .action(async (...args) => {
      const [triggerId, options] = args as [string, WorkspaceOption & RunOptions];
      try {
        const workspaceUrl = input.ctx.effectiveWorkspaceUrl(options.workspace);
        const json = options.inputsJson ? readJsonInputs(options.inputsJson) : undefined;
        const payload = await input.ctx.withAutoRefresh({
          workspaceUrl,
          work: async () => {
            const { client, auth } = await input.ctx.getClientForWorkspace(workspaceUrl);
            const channelId = options.channel
              ? await resolveChannelId(client, options.channel)
              : undefined;
            return await runWorkflow(client, {
              triggerId,
              channelId,
              inputs: { pairs: options.input, json },
              dryRun: options.dryRun === true,
              auth,
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

type RunOptions = {
  channel?: string;
  input?: string[];
  inputsJson?: string;
  dryRun?: boolean;
};

function readJsonInputs(path: string): unknown {
  const raw = path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`--inputs-json ${path} is not valid JSON.`);
  }
}
