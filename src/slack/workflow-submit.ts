import type { SlackApiClient, SlackAuth } from "./client.ts";
import type { FormField, WorkflowSchema } from "./workflows.ts";
import { connectRtm, type RtmConnection } from "../lib/rtm-websocket.ts";
import { runWorkflow } from "./workflows.ts";
import { asArray, getString, isRecord } from "../lib/object-type-guards.ts";

export type WorkflowSubmitResult = {
  function_execution_id: string;
  trigger_execution_id: string;
  view_id: string;
  submitted: boolean;
};

export function requireBrowserAuth(
  auth: SlackAuth,
): asserts auth is Extract<SlackAuth, { auth_type: "browser" }> {
  if (auth.auth_type !== "browser") {
    throw new Error(
      "Form submission requires browser auth (xoxc/xoxd). Standard bot tokens cannot submit workflow forms.",
    );
  }
}

export function validateFieldInputs(fields: Map<string, string>, schema: WorkflowSchema): string[] {
  const errors: string[] = [];
  const available = schema.fields.map((f) => f.title);
  const titleToField = new Map<string, FormField>();
  for (const f of schema.fields) {
    titleToField.set(f.title.toLowerCase(), f);
  }

  // Check for unknown field titles
  for (const [title] of fields) {
    if (!titleToField.has(title.toLowerCase())) {
      errors.push(`Unknown field "${title}". Available: ${available.join(", ")}`);
    }
  }

  // Check for missing required fields
  for (const f of schema.fields) {
    if (f.required && !fields.has(f.title.toLowerCase()) && !fields.has(f.title)) {
      errors.push(`Required field "${f.title}" is missing`);
    }
  }

  return errors;
}

export async function submitWorkflow(input: {
  client: SlackApiClient;
  auth: Extract<SlackAuth, { auth_type: "browser" }>;
  shortcutUrl: string;
  channelId: string;
  triggerId: string;
  fields: Map<string, string>;
  schema: WorkflowSchema;
}): Promise<WorkflowSubmitResult> {
  const { client, auth, shortcutUrl, channelId, triggerId, fields, schema } = input;
  const cookie = `d=${encodeURIComponent(auth.xoxd_cookie)}`;

  // Build title→FormField lookup (case-insensitive)
  const titleToField = new Map<string, FormField>();
  for (const f of schema.fields) {
    titleToField.set(f.title.toLowerCase(), f);
  }

  // Step 1: RTM connect
  const rtmResp = await client.api("rtm.connect", {});
  const wsUrl = getString(rtmResp.url);
  if (!wsUrl) {
    throw new Error("rtm.connect did not return a WebSocket URL");
  }

  let rtm: RtmConnection | null = null;
  try {
    // Step 2: Open WebSocket
    rtm = await connectRtm({ wsUrl, cookie });

    // Step 3: Start waiting for view_opened BEFORE tripping (it can arrive before trip resolves)
    const viewPromise = rtm.waitForMessage(
      (msg) => msg.type === "view_opened" || msg.type === "view_push",
      15000,
    );

    // Step 4: Trip trigger
    const tripResult = await runWorkflow(client, { shortcutUrl, channelId, triggerId });

    // Step 5: Wait for view_opened
    const viewMsg = await viewPromise;
    const view = isRecord(viewMsg.view) ? viewMsg.view : {};
    const viewId = getString(view.id);
    if (!viewId) {
      throw new Error("view_opened event did not contain a view_id");
    }

    // Step 6: Extract block_id → action_id mapping from the view
    const blocks = asArray(view.blocks).filter(isRecord);
    const stateValues: Record<string, Record<string, { type: string; value: string }>> = {};

    for (const block of blocks) {
      const blockId = getString(block.block_id);
      if (!blockId) {
        continue;
      }

      const element = isRecord(block.element) ? block.element : {};
      const actionId = getString(element.action_id);
      if (!actionId) {
        continue;
      }

      // Match action_id (field UUID) to a schema field by name
      const schemaField = schema.fields.find((f) => f.name === actionId);
      if (!schemaField) {
        continue;
      }

      // Look up user-supplied value by title (case-insensitive)
      const userValue =
        fields.get(schemaField.title.toLowerCase()) ?? fields.get(schemaField.title);
      if (userValue === undefined) {
        continue;
      }

      stateValues[blockId] = {
        [actionId]: {
          type: "plain_text_input",
          value: userValue,
        },
      };
    }

    // Step 7: Submit
    await client.api("views.submit", {
      view_id: viewId,
      client_token: `cli-${Date.now()}`,
      state: JSON.stringify({ values: stateValues }),
    });

    return {
      function_execution_id: tripResult.function_execution_id,
      trigger_execution_id: tripResult.trigger_execution_id,
      view_id: viewId,
      submitted: true,
    };
  } finally {
    rtm?.close();
  }
}
