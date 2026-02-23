import type { SlackApiClient } from "./client.ts";
import { asArray, getString, isRecord } from "../lib/object-type-guards.ts";

export type ChannelWorkflow = {
  title: string;
  trigger_id: string;
  link?: string;
  app_id?: string;
  featured: boolean;
};

export type ChannelWorkflows = {
  channel_id: string;
  workflows: ChannelWorkflow[];
};

export async function listChannelWorkflows(
  client: SlackApiClient,
  channelId: string,
): Promise<ChannelWorkflows> {
  const [bookmarked, featured] = await Promise.all([
    listBookmarkedWorkflows(client, channelId),
    listFeaturedWorkflows(client, channelId),
  ]);

  // Merge: bookmarked is the primary source, featured adds the flag
  const featuredIds = new Set(featured.map((f) => f.trigger_id));
  const seen = new Set<string>();
  const workflows: ChannelWorkflow[] = [];

  for (const bk of bookmarked) {
    if (bk.trigger_id) {
      seen.add(bk.trigger_id);
    }
    workflows.push({
      title: bk.title,
      trigger_id: bk.trigger_id ?? "",
      link: bk.link,
      app_id: bk.app_id,
      featured: bk.trigger_id ? featuredIds.has(bk.trigger_id) : false,
    });
  }

  // Add any featured workflows not already found in bookmarks
  for (const ft of featured) {
    if (!seen.has(ft.trigger_id)) {
      workflows.push({
        title: ft.title,
        trigger_id: ft.trigger_id,
        featured: true,
      });
    }
  }

  return { channel_id: channelId, workflows };
}

type BookmarkedWorkflow = {
  title: string;
  trigger_id?: string;
  link?: string;
  app_id?: string;
};

async function listBookmarkedWorkflows(
  client: SlackApiClient,
  channelId: string,
): Promise<BookmarkedWorkflow[]> {
  const resp = await client.api("bookmarks.list", {
    channel_id: channelId,
  });
  return asArray(resp.bookmarks)
    .filter(isRecord)
    .filter((b) => {
      const link = getString(b.link) ?? "";
      const shortcutId = getString(b.shortcut_id);
      return shortcutId || link.includes("slack.com/shortcuts/");
    })
    .map((b) => {
      const link = getString(b.link);
      const shortcutId = getString(b.shortcut_id);
      const triggerId = shortcutId || extractTriggerId(link);
      return {
        title: getString(b.title) ?? "",
        trigger_id: triggerId,
        link,
        app_id: getString(b.app_id),
      };
    });
}

type FeaturedWorkflow = {
  trigger_id: string;
  title: string;
};

async function listFeaturedWorkflows(
  client: SlackApiClient,
  channelId: string,
): Promise<FeaturedWorkflow[]> {
  try {
    const resp = await client.api("workflows.featured.list", {
      channel_ids: JSON.stringify([channelId]),
    });
    const entries = asArray(resp.featured_workflows).filter(isRecord);
    const entry = entries.find((e) => getString(e.channel_id) === channelId);
    if (!entry) {
      return [];
    }
    return asArray(entry.triggers)
      .filter(isRecord)
      .map((t) => ({
        trigger_id: getString(t.id) ?? "",
        title: getString(t.title) ?? "",
      }))
      .filter((t) => t.trigger_id);
  } catch {
    // workflows.featured.list may not be available — not fatal
    return [];
  }
}

export type WorkflowPreview = {
  trigger_id: string;
  type: string;
  name: string;
  description: string;
  shortcut_url?: string;
  workflow: {
    id: string;
    title: string;
    description: string;
    app_id: string;
    app_name: string;
  };
  collaborators: string[];
};

export async function previewWorkflow(
  client: SlackApiClient,
  triggerId: string,
): Promise<WorkflowPreview> {
  const resp = await client.api("workflows.triggers.preview", {
    trigger_ids: triggerId,
  });
  const triggers = asArray(resp.triggers).filter(isRecord);
  if (triggers.length === 0) {
    const rejected = asArray(resp.rejected_triggers);
    if (rejected.length > 0) {
      throw new Error(`Trigger ${triggerId} was rejected — you may not have access`);
    }
    throw new Error(`No preview data returned for trigger ${triggerId}`);
  }
  const t = triggers[0]!;
  const wf = isRecord(t.workflow) ? t.workflow : {};
  const wfApp = isRecord(wf.app) ? wf.app : {};
  const details = isRecord(t.workflow_details) ? t.workflow_details : {};
  return {
    trigger_id: getString(t.id) ?? triggerId,
    type: getString(t.type) ?? "",
    name: getString(t.name) ?? "",
    description: getString(t.description) ?? "",
    shortcut_url: getString(t.shortcut_url),
    workflow: {
      id: getString(wf.workflow_id) ?? "",
      title: getString(wf.title) ?? "",
      description: getString(wf.description) ?? "",
      app_id: getString(wf.app_id) ?? getString(wfApp.id) ?? "",
      app_name: getString(wfApp.name) ?? "",
    },
    collaborators: asArray(details.collaborators)
      .map((c) => (typeof c === "string" ? c : ""))
      .filter(Boolean),
  };
}

export type WorkflowRunResult = {
  function_execution_id: string;
  trigger_execution_id: string;
  is_slow_workflow: boolean;
};

export async function runWorkflow(
  client: SlackApiClient,
  input: { shortcutUrl: string; channelId: string; triggerId: string },
): Promise<WorkflowRunResult> {
  const clientToken = `cli-${Date.now()}`;
  const resp = await client.api("workflows.triggers.trip", {
    url: input.shortcutUrl,
    client_token: clientToken,
    context: JSON.stringify({
      location: "bookmark",
      channel_id: input.channelId,
      bookmark_id: input.triggerId,
    }),
    run_precheck: true,
  });
  return {
    function_execution_id: getString(resp.function_execution_id) ?? "",
    trigger_execution_id: getString(resp.trigger_execution_id) ?? "",
    is_slow_workflow: resp.is_slow_workflow === true,
  };
}

export async function resolveShortcutUrl(
  client: SlackApiClient,
  input: { channelId: string; triggerId: string },
): Promise<string> {
  const { channelId, triggerId } = input;
  const resp = await client.api("bookmarks.list", {
    channel_id: channelId,
  });
  const bookmarks = asArray(resp.bookmarks).filter(isRecord);
  for (const b of bookmarks) {
    const shortcutId = getString(b.shortcut_id);
    if (shortcutId === triggerId) {
      const link = getString(b.link);
      if (link) {
        return link;
      }
    }
  }
  throw new Error(`Could not find shortcut URL for trigger ${triggerId} in channel bookmarks`);
}

export type FormField = {
  name: string;
  title: string;
  type: string;
  description: string;
  required: boolean;
  long?: boolean;
};

export type WorkflowSchema = {
  workflow_id: string;
  title: string;
  description: string;
  form_title?: string;
  fields: FormField[];
  steps: string[];
};

export async function getWorkflowSchema(
  client: SlackApiClient,
  workflowId: string,
): Promise<WorkflowSchema> {
  const resp = await client.api("workflows.get", { workflow_id: workflowId });
  const wf = isRecord(resp.workflow) ? resp.workflow : null;
  if (!wf) {
    throw new Error(`No workflow found for ID ${workflowId}`);
  }

  const steps = asArray(wf.steps).filter(isRecord);
  const stepSummaries: string[] = [];
  let fields: FormField[] = [];
  let formTitle: string | undefined;

  for (const step of steps) {
    const fn = isRecord(step.function) ? step.function : {};
    const callbackId = getString(fn.callback_id) ?? "";
    const title = getString(fn.title) ?? callbackId;
    stepSummaries.push(title);

    if (callbackId === "open_form") {
      const inputs = isRecord(step.inputs) ? step.inputs : {};
      const titleInput = isRecord(inputs.title) ? inputs.title : {};
      formTitle = getString(titleInput.value);

      const fieldsInput = isRecord(inputs.fields) ? inputs.fields : {};
      const fieldsValue = isRecord(fieldsInput.value) ? fieldsInput.value : {};
      const elements = asArray(fieldsValue.elements).filter(isRecord);
      const required = new Set(
        asArray(fieldsValue.required)
          .map((r) => (typeof r === "string" ? r : ""))
          .filter(Boolean),
      );

      fields = elements.map((el) => ({
        name: getString(el.name) ?? "",
        title: getString(el.title) ?? "",
        type: getString(el.type) ?? "string",
        description: getString(el.description) ?? "",
        required: required.has(getString(el.name) ?? ""),
        long: el.long === true ? true : undefined,
      }));
    }
  }

  return {
    workflow_id: getString(wf.id) ?? workflowId,
    title: getString(wf.title) ?? "",
    description: getString(wf.description) ?? "",
    form_title: formTitle,
    fields,
    steps: stepSummaries,
  };
}

function extractTriggerId(link: string | undefined): string | undefined {
  if (!link) {
    return undefined;
  }
  const match = link.match(/slack\.com\/shortcuts\/(Ft[A-Za-z0-9]+)/);
  return match?.[1];
}
