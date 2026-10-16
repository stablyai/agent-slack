import type { SlackApiClient } from "./client.ts";
import { resolveChannelName } from "./channels.ts";
import { fetchMessage, toCompactMessage } from "./messages.ts";
import { extractMrkdwnFromRichTextBlock } from "./render-rich-text.ts";
import { buildSlackMessageUrl, parseSlackMessageUrl } from "./url.ts";
import { asArray, getNumber, getString, isRecord } from "../lib/object-type-guards.ts";

export type TodoRef = { item_type: "reminder" | "message"; item_id: string; ts?: string };

export function parseTodoTarget(input: string): { ref: TodoRef; workspaceUrl?: string } {
  if (/^Sa[A-Z0-9]+$/.test(input)) {
    return { ref: { item_type: "reminder", item_id: input } };
  }
  const url = parseSlackMessageUrl(input);
  return {
    ref: { item_type: "message", item_id: url.channel_id, ts: url.message_ts },
    workspaceUrl: url.workspace_url,
  };
}

/** A date_due equal to date_created is how Slack stores "no reminder". */
export async function listTodos(
  client: SlackApiClient,
  input: {
    workspaceUrl: string;
    all?: boolean;
    limit: number;
    cursor?: string;
    maxBodyChars: number;
  },
) {
  const { workspaceUrl, maxBodyChars } = input;
  const resp = await client.api("saved.list", {
    filter: input.all ? "todo_with_completed" : "todo",
    limit: input.limit,
    cursor: input.cursor,
  });
  const items = asArray(resp.saved_items)
    .filter(isRecord)
    .map(async (item) => {
      const id = getString(item.item_id) ?? "";
      const ts = getString(item.ts);
      const due = getNumber(item.date_due);
      const todo = {
        id,
        item_type: getString(item.item_type),
        state: item.todo_state === "completed" ? "completed" : "open",
        remind_at: due && due !== item.date_created ? due : undefined,
        date_created: getNumber(item.date_created),
        date_completed: getNumber(item.date_completed) || undefined,
      };
      if (item.item_type !== "message" || !ts) {
        const text = asArray(item.description).map((b) => extractMrkdwnFromRichTextBlock(b));
        return { ...todo, text: text.join("\n\n") };
      }
      const ref = { workspace_url: workspaceUrl, channel_id: id, message_ts: ts };
      const url = buildSlackMessageUrl(ref);
      const [channel_name, message] = await Promise.all([
        resolveChannelName(client, id),
        fetchMessage(client, { ref: { ...ref, raw: url } }).then(
          (msg) => toCompactMessage(msg, { maxBodyChars }),
          () => undefined,
        ),
      ]);
      return { ...todo, id: url, channel_name, message };
    });
  const meta = isRecord(resp.response_metadata) ? resp.response_metadata : {};
  return { items: await Promise.all(items), next_cursor: getString(meta.next_cursor) };
}

/**
 * saved.add leaves an already-saved message in Saved, and its date_due sets the
 * to-do's date rather than a reminder, so both go through saved.update.
 */
export async function addTodo(
  client: SlackApiClient,
  input: { item: TodoRef | string; remindAt?: number },
): Promise<TodoRef> {
  const { item, remindAt } = input;
  const section = { type: "rich_text_section", elements: [{ type: "text", text: item }] };
  const resp = await client.api("saved.add", {
    ...(typeof item === "string"
      ? { item_type: "reminder", description: [{ type: "rich_text", elements: [section] }] }
      : item),
    todo_state: "to_do",
  });
  const added = isRecord(resp.item) ? resp.item : {};
  const id = getString(added.item_id) ?? "";
  const ref: TodoRef = typeof item === "string" ? { item_type: "reminder", item_id: id } : item;
  if (added.todo_state !== "to_do" || remindAt) {
    await client.apiMultipart("saved.update", { ...ref, todo_state: "to_do", date_due: remindAt });
  }
  return ref;
}
