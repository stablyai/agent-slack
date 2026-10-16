import { describe, expect, test } from "bun:test";
import { addTodo, listTodos, parseTodoTarget } from "../src/slack/todos.ts";
import type { SlackApiClient } from "../src/slack/client.ts";

const WS = "https://acme.slack.com";
const URL = `${WS}/archives/C1/p1700000000000100`;

function mockClient(responses: Record<string, Record<string, unknown>>) {
  const calls: [string, Record<string, unknown>][] = [];
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    calls.push([method, params]);
    return responses[method] ?? { ok: true };
  };
  return { client: { api: call, apiMultipart: call } as unknown as SlackApiClient, calls };
}

describe("todos", () => {
  test("parseTodoTarget takes to-do ids and message URLs", () => {
    expect(parseTodoTarget("Sa0CANNV3FMW").ref).toEqual({
      item_type: "reminder",
      item_id: "Sa0CANNV3FMW",
    });
    expect(parseTodoTarget(URL)).toEqual({
      ref: { item_type: "message", item_id: "C1", ts: "1700000000.000100" },
      workspaceUrl: WS,
    });
  });

  test("listTodos renders text and message to-dos", async () => {
    const text = (t: string) => [
      {
        type: "rich_text",
        elements: [{ type: "rich_text_section", elements: [{ type: "text", text: t }] }],
      },
    ];
    const { client, calls } = mockClient({
      "saved.list": {
        saved_items: [
          {
            item_id: "Sa1",
            item_type: "reminder",
            date_created: 9,
            date_due: 9,
            description: text("a"),
          },
          {
            item_id: "Sa2",
            item_type: "reminder",
            date_created: 9,
            date_due: 50,
            todo_state: "completed",
          },
          { item_id: "C1", item_type: "message", ts: "1700000000.000100", date_due: 0 },
        ],
        response_metadata: { next_cursor: "c2" },
      },
      "conversations.info": { channel: { name: "general" } },
      "conversations.history": { messages: [{ ts: "1700000000.000100", text: "ship it" }] },
    });

    const out = await listTodos(client, {
      workspaceUrl: WS,
      all: true,
      limit: 3,
      maxBodyChars: 100,
    });

    expect(calls[0]).toEqual([
      "saved.list",
      { filter: "todo_with_completed", limit: 3, cursor: undefined },
    ]);
    expect(out.next_cursor).toBe("c2");
    expect(out.items[0]).toMatchObject({
      id: "Sa1",
      state: "open",
      remind_at: undefined,
      text: "a",
    });
    expect(out.items[1]).toMatchObject({ id: "Sa2", state: "completed", remind_at: 50 });
    expect(out.items[2]).toMatchObject({
      id: URL,
      channel_name: "general",
      message: { content: "ship it" },
    });
  });

  test("addTodo sets reminders and moves saved messages with saved.update", async () => {
    const text = mockClient({ "saved.add": { item: { item_id: "Sa9", todo_state: "to_do" } } });
    expect(await addTodo(text.client, { item: "call Bob", remindAt: 90 })).toEqual({
      item_type: "reminder",
      item_id: "Sa9",
    });
    expect(text.calls[1]).toEqual([
      "saved.update",
      { item_type: "reminder", item_id: "Sa9", todo_state: "to_do", date_due: 90 },
    ]);

    const { ref } = parseTodoTarget(URL);
    const saved = mockClient({ "saved.add": { item: { todo_state: "saved" } } });
    await addTodo(saved.client, { item: ref });
    expect(saved.calls.map(([m, p]) => [m, p.todo_state])).toEqual([
      ["saved.add", "to_do"],
      ["saved.update", "to_do"],
    ]);

    const todo = mockClient({ "saved.add": { item: { todo_state: "to_do" } } });
    await addTodo(todo.client, { item: ref });
    expect(todo.calls).toHaveLength(1);
  });
});
