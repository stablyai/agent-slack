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
import {
  requireBrowserAuth,
  submitWorkflow,
  validateFieldInputs,
} from "../slack/workflow-submit.ts";

type WorkspaceOption = {
  workspace?: string;
};

type RunOptions = WorkspaceOption & {
  channel: string;
  field?: string[];
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
    .description("Trip a workflow trigger (with --field, submits form data)")
    .argument("<trigger-id>", "Trigger ID (Ft...)")
    .requiredOption("--channel <id-or-name>", "Channel where the workflow is bookmarked")
    .option(
      "--field <title=value>",
      "Form field value (repeatable)",
      (v, prev: string[]) => {
        prev.push(v);
        return prev;
      },
      [] as string[],
    )
    .option(
      "--workspace <url>",
      "Workspace selector (full URL or unique substring; required if you have multiple workspaces)",
    )
    .action(async (...args) => {
      const [triggerId, options] = args as [string, RunOptions];
      try {
        const workspaceUrl = input.ctx.effectiveWorkspaceUrl(options.workspace);
        const fieldArgs = options.field ?? [];

        if (fieldArgs.length === 0) {
          // Trip-only (existing behavior, no WebSocket)
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
        } else {
          // Parse --field args
          const fields = new Map<string, string>();
          for (const arg of fieldArgs) {
            const eqIdx = arg.indexOf("=");
            if (eqIdx < 1) {
              throw new Error(`Invalid --field format: "${arg}". Expected Title=value`);
            }
            fields.set(arg.substring(0, eqIdx), arg.substring(eqIdx + 1));
          }

          const payload = await input.ctx.withAutoRefresh({
            workspaceUrl,
            work: async () => {
              const { client, auth } = await input.ctx.getClientForWorkspace(workspaceUrl);
              requireBrowserAuth(auth);

              const channelId = await resolveChannelId(client, options.channel);

              // Preview → schema → validate before opening WebSocket
              const preview = await previewWorkflow(client, triggerId);
              const schema = await getWorkflowSchema(client, preview.workflow.id);
              const errors = validateFieldInputs(fields, schema);
              if (errors.length > 0) {
                throw new Error(errors.join("\n"));
              }

              const shortcutUrl = await resolveShortcutUrl(client, { channelId, triggerId });
              return await submitWorkflow({
                client,
                auth,
                shortcutUrl,
                channelId,
                triggerId,
                fields,
                schema,
              });
            },
          });
          console.log(JSON.stringify(pruneEmpty(payload), null, 2));
        }
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });
}
