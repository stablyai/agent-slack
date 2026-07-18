/**
 * Slack-native message drafts via the undocumented `drafts.*` session
 * endpoints (the same API the official Slack clients use). Drafts created
 * here show up natively in the user's Slack client.
 *
 * Requires browser-style auth (xoxc/xoxd); bot/user tokens are rejected by
 * Slack with `unknown_method` / `not_allowed_token_type`.
 */

import type { SlackApiClient } from "./client.ts";
import { asArray, getNumber, getString, isRecord } from "../lib/object-type-guards.ts";
import { extractMrkdwnFromRichTextBlock } from "./render-rich-text.ts";
import { parseInlineElements, textToRichTextBlocks } from "./rich-text.ts";

export type DraftDestination = {
  channel_id: string;
  thread_ts?: string;
  broadcast?: boolean;
};

export type SlackDraft = {
  id: string;
  text?: string;
  destinations: DraftDestination[];
  last_updated_ts?: string;
  date_created?: number;
  date_scheduled?: number;
  file_ids?: string[];
};

/**
 * Pad a draft timestamp's fractional part to 7 digits.
 * Slack rejects `client_last_updated_ts` values with fewer places
 * (e.g. "1700000000.123" must be sent as "1700000000.1230000").
 */
export function padDraftTs(ts: string): string {
  const dot = ts.indexOf(".");
  if (dot === -1) {
    return ts;
  }
  const frac = ts.slice(dot + 1);
  return `${ts.slice(0, dot)}.${frac.padEnd(7, "0")}`;
}

/**
 * Convert draft text to rich_text blocks. Drafts have no plain-text
 * fallback param, so unformatted text is wrapped in a single section.
 */
export function draftTextToBlocks(text: string): unknown[] {
  const rich = textToRichTextBlocks(text, { includeInlineFormatting: true });
  if (rich) {
    return rich;
  }
  return [
    {
      type: "rich_text",
      elements: [{ type: "rich_text_section", elements: parseInlineElements(text) }],
    },
  ];
}

export function parseDraftRecord(raw: unknown): SlackDraft | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = getString(raw.id);
  if (!id) {
    return null;
  }

  const destinations = asArray(raw.destinations)
    .filter(isRecord)
    .flatMap((dest): DraftDestination[] => {
      const channelId = getString(dest.channel_id);
      if (!channelId) {
        return [];
      }
      return [
        {
          channel_id: channelId,
          thread_ts: getString(dest.thread_ts) || undefined,
          broadcast: dest.broadcast === true ? true : undefined,
        },
      ];
    });

  const text = asArray(raw.blocks)
    .map((block) => extractMrkdwnFromRichTextBlock(block))
    .filter((t) => t.trim())
    .join("\n\n")
    .trim();

  const fileIds = asArray(raw.file_ids).filter(
    (fileId): fileId is string => typeof fileId === "string",
  );
  const dateScheduled = getNumber(raw.date_scheduled);

  return {
    id,
    text: text || undefined,
    destinations,
    last_updated_ts: getString(raw.last_updated_ts),
    date_created: getNumber(raw.date_created),
    date_scheduled: dateScheduled && dateScheduled > 0 ? dateScheduled : undefined,
    file_ids: fileIds.length > 0 ? fileIds : undefined,
  };
}

export async function listDrafts(
  client: SlackApiClient,
  options?: { limit?: number; activeOnly?: boolean },
): Promise<{ drafts: SlackDraft[] }> {
  const resp = await client.api("drafts.list", {
    is_active: options?.activeOnly === false ? undefined : true,
    limit: options?.limit,
  });
  const drafts = asArray(resp.drafts)
    .map(parseDraftRecord)
    .filter((draft): draft is SlackDraft => draft !== null);
  return { drafts };
}

export async function findDraft(client: SlackApiClient, draftId: string): Promise<SlackDraft> {
  const { drafts } = await listDrafts(client, { activeOnly: false });
  const matches = drafts.filter((d) => d.id === draftId);
  // update/delete need last_updated_ts for conflict detection, so prefer a
  // usable record if the response happens to include a malformed duplicate
  // (e.g. a first entry missing last_updated_ts).
  const draft = matches.find((d) => d.last_updated_ts) ?? matches[0];
  if (!draft) {
    throw new Error(`Draft not found: ${draftId}. Run "message draft list" to see draft ids.`);
  }
  return draft;
}

/**
 * Shared wire payload for drafts.create / drafts.update: text wrapped as a
 * rich_text block, addressed to one destination, with a fresh client_msg_id.
 * `blocks`, `destinations` and `file_ids` are serialized to JSON strings by
 * the form-encoding client, which is what these endpoints expect.
 */
function buildDraftBody(input: {
  channelId: string;
  text: string;
  threadTs?: string;
  broadcast?: boolean;
  fileIds?: string[];
}): Record<string, unknown> {
  const destination: DraftDestination = { channel_id: input.channelId };
  if (input.threadTs) {
    destination.thread_ts = input.threadTs;
    destination.broadcast = input.broadcast === true;
  }
  return {
    blocks: draftTextToBlocks(input.text),
    destinations: [destination],
    client_msg_id: crypto.randomUUID(),
    file_ids: input.fileIds ?? [],
  };
}

export async function createDraft(
  client: SlackApiClient,
  input: {
    channelId: string;
    text: string;
    threadTs?: string;
    broadcast?: boolean;
  },
): Promise<SlackDraft | null> {
  const resp = await client.api("drafts.create", {
    ...buildDraftBody(input),
    // Sent on create only, matching the official client's behavior.
    is_from_composer: true,
  });
  return parseDraftRecord(resp.draft);
}

export async function updateDraft(
  client: SlackApiClient,
  input: {
    draftId: string;
    clientLastUpdatedTs: string;
    channelId: string;
    text: string;
    threadTs?: string;
    broadcast?: boolean;
    fileIds?: string[];
  },
): Promise<SlackDraft | null> {
  const resp = await client.api("drafts.update", {
    ...buildDraftBody(input),
    draft_id: input.draftId,
    client_last_updated_ts: padDraftTs(input.clientLastUpdatedTs),
  });
  return parseDraftRecord(resp.draft);
}

export async function deleteDraft(
  client: SlackApiClient,
  input: { draftId: string; clientLastUpdatedTs?: string },
): Promise<void> {
  // Slack requires the draft's last-updated ts to detect conflicts; fetch it
  // when the caller doesn't have one.
  const ts = input.clientLastUpdatedTs ?? (await findDraft(client, input.draftId)).last_updated_ts;
  if (!ts) {
    throw new Error(`Draft ${input.draftId} has no last_updated_ts; cannot delete.`);
  }
  await client.api("drafts.delete", {
    draft_id: input.draftId,
    client_last_updated_ts: padDraftTs(ts),
  });
}
