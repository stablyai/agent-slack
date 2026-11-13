import type { SlackApiClient, SlackAuth } from "./client.ts";
import { getString, isRecord } from "../lib/object-type-guards.ts";
import { connectEventSocket, type EventSocketConnector } from "./event-socket.ts";
import {
  buildViewState,
  resolveWorkflowInputs,
  type RawWorkflowInputs,
  type ResolvedWorkflowInput,
} from "./workflow-form.ts";
import { getWorkflowSchema, previewWorkflow, resolveShortcutUrl } from "./workflows.ts";

export type WorkflowRunResult = {
  function_execution_id: string;
  trigger_execution_id: string;
  is_slow_workflow: boolean;
  /** Set when a form was filled in and submitted. */
  form_submitted?: boolean;
};

export type WorkflowDryRun = {
  dry_run: true;
  trigger_id: string;
  workflow_id: string;
  form_title?: string;
  inputs: ResolvedWorkflowInput[];
};

export type WorkflowRunInput = {
  triggerId: string;
  /** Channel the trigger is shown in; used as trip context and URL fallback. */
  channelId?: string;
  inputs?: RawWorkflowInputs;
  dryRun?: boolean;
  /** Credentials of `client`; required to receive and submit the form. */
  auth?: SlackAuth;
  connectSocket?: EventSocketConnector;
};

const FORM_OPEN_TIMEOUT_MS = 15_000;

async function tripTrigger(
  client: SlackApiClient,
  input: { shortcutUrl: string; channelId?: string; clientToken: string },
): Promise<WorkflowRunResult> {
  const context = input.channelId
    ? { location: "channel_details", channel_id: input.channelId }
    : { location: "markdown_link" };
  const resp = await client.api("workflows.triggers.trip", {
    url: input.shortcutUrl,
    client_token: input.clientToken,
    context: JSON.stringify(context),
    run_precheck: true,
  });
  return {
    function_execution_id: getString(resp.function_execution_id) ?? "",
    trigger_execution_id: getString(resp.trigger_execution_id) ?? "",
    is_slow_workflow: resp.is_slow_workflow === true,
  };
}

/**
 * Trip a workflow trigger. When the workflow opens a form, the form is filled
 * from `inputs` and submitted the way the Slack web client does: the trip's
 * `view_opened` event (delivered over the realtime socket) carries the form
 * view, which is then answered with `views.submit`.
 */
export async function runWorkflow(
  client: SlackApiClient,
  input: WorkflowRunInput,
): Promise<WorkflowRunResult | WorkflowDryRun> {
  const preview = await previewWorkflow(client, input.triggerId);
  const schema = preview.workflow.id ? await getWorkflowSchema(client, preview.workflow.id) : null;
  const fields = schema?.fields ?? [];
  const raw = input.inputs ?? {};
  const hasInputs = (raw.pairs?.length ?? 0) > 0 || raw.json !== undefined;
  if (fields.length === 0 && hasInputs) {
    throw new Error("This workflow has no form fields; drop --input / --inputs-json.");
  }
  const resolved = resolveWorkflowInputs(fields, raw);

  if (input.dryRun) {
    return {
      dry_run: true,
      trigger_id: preview.trigger_id,
      workflow_id: preview.workflow.id,
      form_title: schema?.form_title,
      inputs: resolved,
    };
  }

  const shortcutUrl =
    preview.shortcut_url ??
    (input.channelId
      ? await resolveShortcutUrl(client, { channelId: input.channelId, triggerId: input.triggerId })
      : undefined);
  if (!shortcutUrl) {
    throw new Error(
      `Could not find a shortcut URL for trigger ${input.triggerId}; pass --channel.`,
    );
  }

  const clientToken = `cli-${Date.now()}`;
  if (fields.length === 0) {
    return await tripTrigger(client, { shortcutUrl, channelId: input.channelId, clientToken });
  }
  if (!input.auth) {
    throw new Error("Submitting a workflow form requires Slack credentials.");
  }

  const socket = await (input.connectSocket ?? connectEventSocket)(input.auth);
  try {
    const tripped = await tripTrigger(client, {
      shortcutUrl,
      channelId: input.channelId,
      clientToken,
    });
    const opened = await socket
      .waitFor(
        (e) => e.type === "view_opened" && e.client_token === clientToken,
        FORM_OPEN_TIMEOUT_MS,
      )
      .catch(() => {
        throw new Error(
          `The workflow was triggered but Slack did not open its form within ${FORM_OPEN_TIMEOUT_MS / 1000}s; nothing was submitted.`,
        );
      });
    const view = isRecord(opened.view) ? opened.view : {};
    const viewId = getString(opened.view_id) ?? getString(view.id);
    if (!viewId) {
      throw new Error("Slack opened the workflow form without a view id.");
    }
    const state = buildViewState(view, resolved);
    const submitted = await client.api("views.submit", {
      client_token: `cli-${Date.now()}-submit`,
      view_id: viewId,
      state: JSON.stringify(state),
    });
    if (submitted.response_action === "errors") {
      throw new Error(`Slack rejected the form: ${JSON.stringify(submitted.errors ?? {})}`);
    }
    return { ...tripped, form_submitted: true };
  } finally {
    socket.close();
  }
}
