import type { SlackApiClient } from "./client.ts";
import { asArray, getString, isRecord } from "../lib/object-type-guards.ts";

export function isChannelId(input: string): boolean {
  return /^[CDG][A-Z0-9]{8,}$/.test(input);
}

export function normalizeChannelInput(input: string): {
  kind: "id" | "name";
  value: string;
} {
  const trimmed = input.trim();
  if (trimmed.startsWith("#")) {
    return { kind: "name", value: trimmed.slice(1) };
  }
  if (isChannelId(trimmed)) {
    return { kind: "id", value: trimmed };
  }
  return { kind: "name", value: trimmed };
}

export async function resolveChannelId(client: SlackApiClient, input: string): Promise<string> {
  const normalized = normalizeChannelInput(input);
  if (normalized.kind === "id") {
    return normalized.value;
  }

  const name = normalized.value;
  if (!name) {
    throw new Error("Channel name is empty");
  }

  // Slack has no name→ID lookup API. conversations.list paginates the entire
  // workspace (200 at a time), which is O(channels) API calls — 3+ minutes in
  // large workspaces. search.messages with `in:#name` resolves it in one call
  // by returning a message whose metadata includes the channel ID.
  try {
    const searchResp = await client.api("search.messages", {
      query: `in:#${name}`,
      count: 1,
      sort: "timestamp",
      sort_dir: "desc",
    });
    const messages = isRecord(searchResp) ? searchResp.messages : null;
    const matches = isRecord(messages) ? asArray(messages.matches).filter(isRecord) : [];
    if (matches.length > 0) {
      const channel = isRecord(matches[0]!.channel) ? matches[0]!.channel : null;
      const channelId = channel ? getString(channel.id) : undefined;
      if (channelId) {
        return channelId;
      }
    }
  } catch {
    // search may fail (e.g. token lacks search:read scope) — fall through to pagination
  }

  // Fallback: paginate conversations.list until we find a match
  let cursor: string | undefined;
  for (;;) {
    const resp = await client.api("conversations.list", {
      exclude_archived: true,
      limit: 200,
      cursor,
      types: "public_channel,private_channel",
    });
    const chans = asArray(resp.channels).filter(isRecord);
    for (const c of chans) {
      if (getString(c.name) === name && getString(c.id)) {
        return getString(c.id)!;
      }
    }

    const meta = isRecord(resp.response_metadata) ? resp.response_metadata : null;
    const next = meta ? getString(meta.next_cursor) : undefined;
    if (!next) {
      break;
    }
    cursor = next;
  }

  throw new Error(`Could not resolve channel name: #${name}`);
}
