import { describe, expect, test } from "bun:test";
import type { SlackApiClient, SlackAuth } from "../src/slack/client.ts";
import type { EventSocket, EventSocketConnector, SlackEvent } from "../src/slack/event-socket.ts";
import {
  runWorkflow,
  type WorkflowDryRun,
  type WorkflowRunResult,
} from "../src/slack/workflow-run.ts";
import { getWorkflowSchema } from "../src/slack/workflows.ts";

const SHORTCUT = "https://slack.com/shortcuts/Ft000TEST/0123456789abcdef0123456789abcdef";
const auth: SlackAuth = { auth_type: "browser", xoxc_token: "xoxc-test", xoxd_cookie: "cookie" };

const richChoice = (id: string, title: string) => ({
  id,
  title,
  value: [
    {
      type: "rich_text",
      elements: [{ type: "rich_text_section", elements: [{ type: "text", text: title }] }],
    },
  ],
});

const workflowGet = (elements: unknown[], required: string[]) => ({
  ok: true,
  workflow: {
    id: "Wf000TEST",
    title: "Request",
    steps: [
      {
        function: { callback_id: "open_form", title: "Open a form" },
        inputs: {
          title: { value: "Request form" },
          fields: { value: { elements, required } },
        },
      },
    ],
  },
});

const formElements = [
  { name: "uuid-note", type: "string", title: "Note", long: true, is_required: true },
  {
    name: "uuid-prio",
    type: "slack#/types/limited_rich_text",
    title: "Priority",
    choices: [richChoice("o1", "Low"), richChoice("o2", "High")],
  },
];

function createClient(overrides: Record<string, Record<string, unknown>> = {}) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const responses: Record<string, Record<string, unknown>> = {
    "workflows.triggers.preview": {
      ok: true,
      triggers: [
        {
          id: "Ft000TEST",
          type: "shortcut",
          shortcut_url: SHORTCUT,
          workflow: { workflow_id: "Wf000TEST", title: "Request" },
        },
      ],
    },
    "workflows.get": workflowGet(formElements, ["uuid-note"]),
    "workflows.triggers.trip": {
      ok: true,
      function_execution_id: "Fx1",
      trigger_execution_id: "Tr1",
      is_slow_workflow: false,
    },
    "views.submit": { ok: true, view: null, response_action: "clear" },
    ...overrides,
  };
  const client = {
    api: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      return responses[method] ?? { ok: true };
    },
  } as unknown as SlackApiClient;
  return { client, calls };
}

const richOption = (text: string) => ({
  text: {
    type: "rich_text",
    elements: [{ type: "rich_text_section", elements: [{ type: "text", text }] }],
  },
  value: text,
});

/** Socket stub that replies to the trip with a form view carrying the trip's client token. */
function createConnector(calls: { method: string; params: Record<string, unknown> }[]) {
  const state = { closed: false, connected: 0 };
  const connect: EventSocketConnector = async () => {
    state.connected += 1;
    const socket: EventSocket = {
      waitFor: async (predicate) => {
        const trip = calls.find((c) => c.method === "workflows.triggers.trip");
        const event: SlackEvent = {
          type: "view_opened",
          view_id: "V1",
          client_token: trip?.params.client_token,
          view: {
            id: "V1",
            blocks: [
              {
                block_id: "B1",
                element: { type: "plain_text_input", action_id: "uuid-note" },
              },
              {
                block_id: "B2",
                element: {
                  type: "static_select",
                  action_id: "uuid-prio",
                  options: [richOption("Low"), richOption("High")],
                },
              },
            ],
          },
        };
        if (!predicate(event)) {
          throw new Error("predicate rejected the form event");
        }
        return event;
      },
      close: () => {
        state.closed = true;
      },
    };
    return socket;
  };
  return { connect, state };
}

describe("getWorkflowSchema", () => {
  test("exposes dropdown option labels", async () => {
    const { client } = createClient();
    const schema = await getWorkflowSchema(client, "Wf000TEST");
    expect(schema.fields.map((f) => [f.title, f.required, f.options])).toEqual([
      ["Note", true, undefined],
      ["Priority", false, ["Low", "High"]],
    ]);
  });
});

describe("runWorkflow", () => {
  test("--dry-run resolves the payload and never trips or submits", async () => {
    const { client, calls } = createClient();
    const result = (await runWorkflow(client, {
      triggerId: "Ft000TEST",
      inputs: { pairs: ["note=Hello", "priority=high"] },
      dryRun: true,
    })) as WorkflowDryRun;

    expect(result.dry_run).toBe(true);
    expect(result.form_title).toBe("Request form");
    expect(result.inputs.map((i) => [i.title, i.value])).toEqual([
      ["Note", "Hello"],
      ["Priority", "High"],
    ]);
    expect(calls.map((c) => c.method)).toEqual(["workflows.triggers.preview", "workflows.get"]);
  });

  test("validates required fields before any trip", async () => {
    const { client, calls } = createClient();
    await expect(
      runWorkflow(client, { triggerId: "Ft000TEST", inputs: { pairs: ["Priority=Low"] } }),
    ).rejects.toThrow('Missing required input: "Note"');
    expect(calls.some((c) => c.method === "workflows.triggers.trip")).toBe(false);
  });

  test("trips with a valid context, then submits the filled form", async () => {
    const { client, calls } = createClient();
    const { connect, state } = createConnector(calls);
    const result = (await runWorkflow(client, {
      triggerId: "Ft000TEST",
      inputs: { pairs: ["Note=Hello", "Priority=High"] },
      auth,
      connectSocket: connect,
    })) as WorkflowRunResult;

    expect(result).toEqual({
      function_execution_id: "Fx1",
      trigger_execution_id: "Tr1",
      is_slow_workflow: false,
      form_submitted: true,
    });
    expect(state.closed).toBe(true);

    const trip = calls.find((c) => c.method === "workflows.triggers.trip")!;
    expect(trip.params.url).toBe(SHORTCUT);
    expect(JSON.parse(String(trip.params.context))).toEqual({ location: "markdown_link" });

    const submit = calls.find((c) => c.method === "views.submit")!;
    expect(submit.params.view_id).toBe("V1");
    expect(submit.params.client_token).not.toBe(trip.params.client_token);
    expect(JSON.parse(String(submit.params.state))).toEqual({
      values: {
        B1: { "uuid-note": { type: "plain_text_input", value: "Hello" } },
        B2: { "uuid-prio": { type: "static_select", selected_option: richOption("High") } },
      },
    });
  });

  test("passes the channel as snake_case trip context", async () => {
    const { client, calls } = createClient();
    const { connect } = createConnector(calls);
    await runWorkflow(client, {
      triggerId: "Ft000TEST",
      channelId: "C123",
      inputs: { pairs: ["Note=Hi"] },
      auth,
      connectSocket: connect,
    });
    const trip = calls.find((c) => c.method === "workflows.triggers.trip")!;
    expect(JSON.parse(String(trip.params.context))).toEqual({
      location: "channel_details",
      channel_id: "C123",
    });
  });

  test("surfaces form validation errors returned by views.submit", async () => {
    const { client, calls } = createClient({
      "views.submit": { ok: true, response_action: "errors", errors: { B1: "too long" } },
    });
    const { connect, state } = createConnector(calls);
    await expect(
      runWorkflow(client, {
        triggerId: "Ft000TEST",
        inputs: { pairs: ["Note=Hi"] },
        auth,
        connectSocket: connect,
      }),
    ).rejects.toThrow("Slack rejected the form");
    expect(state.closed).toBe(true);
  });

  test("reports when the form never opens", async () => {
    const { client } = createClient();
    const connect: EventSocketConnector = async () => ({
      waitFor: async () => {
        throw new Error("Timed out waiting for a Slack event.");
      },
      close: () => {},
    });
    await expect(
      runWorkflow(client, {
        triggerId: "Ft000TEST",
        inputs: { pairs: ["Note=Hi"] },
        auth,
        connectSocket: connect,
      }),
    ).rejects.toThrow("did not open its form");
  });

  test("a workflow without a form trips without opening a socket", async () => {
    const { client, calls } = createClient({ "workflows.get": workflowGet([], []) });
    const { connect, state } = createConnector(calls);
    const result = (await runWorkflow(client, {
      triggerId: "Ft000TEST",
      auth,
      connectSocket: connect,
    })) as WorkflowRunResult;
    expect(result.trigger_execution_id).toBe("Tr1");
    expect(result.form_submitted).toBeUndefined();
    expect(state.connected).toBe(0);
    expect(calls.some((c) => c.method === "views.submit")).toBe(false);
  });

  test("rejects inputs for a workflow without a form", async () => {
    const { client } = createClient({ "workflows.get": workflowGet([], []) });
    await expect(
      runWorkflow(client, { triggerId: "Ft000TEST", inputs: { pairs: ["Note=Hi"] } }),
    ).rejects.toThrow("has no form fields");
  });
});
