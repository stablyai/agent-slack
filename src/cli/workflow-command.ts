import type { Command } from "commander";
import type { CliContext } from "./context.ts";
import { pruneEmpty } from "../lib/compact-json.ts";
import { resolveChannelId } from "../slack/channels.ts";
import {
  getWorkflowSchema,
  listChannelWorkflows,
  previewWorkflow,
  resolveShortcutUrl,
  runWorkflow,
} from "../slack/workflows.ts";

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
    .description("Trip a workflow trigger")
    .argument("<trigger-id>", "Trigger ID (Ft...)")
    .requiredOption("--channel <id-or-name>", "Channel where the workflow is bookmarked")
    .option(
      "--workspace <url>",
      "Workspace selector (full URL or unique substring; required if you have multiple workspaces)",
    )
    .action(async (...args) => {
      const [triggerId, options] = args as [string, WorkspaceOption & { channel: string }];
      try {
        const workspaceUrl = input.ctx.effectiveWorkspaceUrl(options.workspace);
        const payload = await input.ctx.withAutoRefresh({
          workspaceUrl,
          work: async () => {
            const { client } = await input.ctx.getClientForWorkspace(workspaceUrl);
            const channelId = await resolveChannelId(client, options.channel);
            const shortcutUrl = await resolveShortcutUrl(client, { channelId, triggerId });
            return await runWorkflow(client, { shortcutUrl, channelId, triggerId });
          },
        });
        console.log(JSON.stringify(pruneEmpty(payload), null, 2));
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });
}
