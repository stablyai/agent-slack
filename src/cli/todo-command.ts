import type { Command } from "commander";
import type { CliContext } from "./context.ts";
import { parseMsgTarget } from "./targets.ts";
import type { SlackApiClient } from "../slack/client.ts";
import { parseReminderDuration } from "../slack/later.ts";
import { addTodo, listTodos, parseTodoTarget } from "../slack/todos.ts";
import { pruneEmpty } from "../lib/compact-json.ts";
import { getString } from "../lib/object-type-guards.ts";

const WHEN =
  "30m, 1h, 3h, 2d, tomorrow, monday, or Unix timestamp; named days use this process's local timezone at 9:00";
const WORKSPACE = "Workspace URL (defaults to your configured workspace)";

export function registerTodoCommand(input: { program: Command; ctx: CliContext }): void {
  const { ctx } = input;
  const act =
    <A extends unknown[]>(work: (...args: A) => Promise<unknown>) =>
    (...args: A) =>
      work(...args).then(
        (out) => console.log(JSON.stringify(pruneEmpty(out), null, 2)),
        (err: unknown) => {
          console.error(ctx.errorMessage(err));
          process.exitCode = 1;
        },
      );
  const withClient = <T>(
    workspace: string | undefined,
    work: (client: SlackApiClient, workspaceUrl?: string) => Promise<T>,
  ) => {
    const workspaceUrl = ctx.effectiveWorkspaceUrl(workspace);
    return ctx.withAutoRefresh({
      workspaceUrl,
      work: async () => {
        const { client, workspace_url } = await ctx.getClientForWorkspace(workspaceUrl);
        return work(client, workspace_url);
      },
    });
  };

  const todo = input.program.command("todo").description("Manage your Slack To-dos");

  todo
    .command("list", { isDefault: true })
    .description("List open to-dos")
    .option("--all", "Include completed to-dos")
    .option("--limit <n>", "Max to-dos to show", "20")
    .option("--cursor <cursor>", "next_cursor from a previous list")
    .option("--max-body-chars <n>", "Max message characters per to-do (-1 for unlimited)", "4000")
    .option("--workspace <url>", WORKSPACE)
    .action(
      act(
        (o: {
          all?: boolean;
          limit: string;
          cursor?: string;
          maxBodyChars: string;
          workspace?: string;
        }) =>
          withClient(o.workspace, async (client, workspaceUrl) =>
            listTodos(client, {
              all: o.all,
              cursor: o.cursor,
              workspaceUrl: workspaceUrl ?? getString((await client.api("auth.test")).url) ?? "",
              limit: Number(o.limit),
              maxBodyChars: Number(o.maxBodyChars),
            }),
          ),
      ),
    );

  todo
    .command("add")
    .description("Add a to-do; a Slack message URL adds that message")
    .argument("<text>", "To-do text or Slack message URL")
    .option("--remind <when>", `Set a reminder: ${WHEN}`)
    .option("--workspace <url>", WORKSPACE)
    .action(
      act(async (text: string, o: { remind?: string; workspace?: string }) => {
        const message = parseMsgTarget(text).kind === "url" ? parseTodoTarget(text) : undefined;
        const remind_at = o.remind ? parseReminderDuration(o.remind) : undefined;
        const ref = await withClient(message?.workspaceUrl ?? o.workspace, (client) =>
          addTodo(client, { item: message?.ref ?? text, remindAt: remind_at }),
        );
        return { ok: true, id: message ? text : ref.item_id, remind_at };
      }),
    );

  for (const [name, description, method, change] of [
    ["complete", "Mark a to-do as completed", "saved.update", { mark: "completed" }],
    ["reopen", "Move a completed to-do back to open", "saved.update", { mark: "uncompleted" }],
    ["remind", "Set a reminder on a to-do", "saved.update", {}],
    ["remove", "Delete a to-do", "saved.delete", {}],
  ] as const) {
    const cmd = todo
      .command(name)
      .description(description)
      .argument("<target>", "To-do id (Sa...) or Slack message URL")
      .option("--workspace <url>", WORKSPACE);
    if (name === "remind") {
      cmd.requiredOption("--in <when>", WHEN);
    }
    cmd.action(
      act(async (target: string, o: { in?: string; workspace?: string }) => {
        const { ref, workspaceUrl } = parseTodoTarget(target);
        const remind_at = o.in ? parseReminderDuration(o.in) : undefined;
        await withClient(workspaceUrl ?? o.workspace, (client) =>
          client.apiMultipart(method, { ...ref, ...change, date_due: remind_at }),
        );
        return { ok: true, remind_at };
      }),
    );
  }
}
