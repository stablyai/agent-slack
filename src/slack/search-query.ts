import type { SlackApiClient } from "./client.ts";
import { normalizeChannelInput } from "./channels.ts";
import { asArray, getString, isRecord } from "./search-guards.ts";

export async function buildSlackSearchQuery(
  client: SlackApiClient,
  input: {
    query: string;
    channels?: string[];
    user?: string;
    after?: string;
    before?: string;
  },
): Promise<string> {
  const parts: string[] = [];
  const base = input.query.trim();
  if (base) {
    parts.push(base);
  }

  if (input.after) {
    parts.push(`after:${validateDate(input.after)}`);
  }
  if (input.before) {
    parts.push(`before:${validateDate(input.before)}`);
  }

  if (input.user) {
    const token = await userTokenForSearch(client, input.user);
    if (token) {
      parts.push(token);
    }
  }

  if (input.channels && input.channels.length > 0) {
    for (const ch of input.channels) {
      const inToken = await channelTokenForSearch(client, ch);
      if (inToken) {
        parts.push(inToken);
      }
    }
  }

  return parts.join(" ");
}

export function validateDate(s: string): string {
  const v = s.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new Error(`Invalid date: ${s} (expected YYYY-MM-DD)`);
  }
  return v;
}

export function dateToUnixSeconds(date: string, edge: "start" | "end"): number {
  const d = validateDate(date);
  const iso = edge === "start" ? `${d}T00:00:00.000Z` : `${d}T23:59:59.999Z`;
  return Math.floor(Date.parse(iso) / 1000);
}

async function userTokenForSearch(client: SlackApiClient, user: string): Promise<string | null> {
  const trimmed = user.trim();
  if (!trimmed) {
    return null;
  }

  // Accept @name or name
  if (trimmed.startsWith("@")) {
    return `from:@${trimmed.slice(1)}`;
  }
  if (/^U[A-Z0-9]{8,}$/.test(trimmed)) {
    try {
      const info = await client.api("users.info", { user: trimmed });
      const infoUser = isRecord(info) ? info.user : null;
      const name = isRecord(infoUser) ? (getString(infoUser.name) ?? "").trim() : "";
      return name ? `from:@${name}` : null;
    } catch {
      return null;
    }
  }
  return `from:@${trimmed}`;
}

async function channelTokenForSearch(
  client: SlackApiClient,
  channel: string,
): Promise<string | null> {
  const normalized = normalizeChannelInput(channel);
  if (normalized.kind === "name") {
    const name = normalized.value.trim();
    if (!name) {
      return null;
    }
    return `in:#${name}`;
  }

  // Channel id -> name for use in search query.
  try {
    const info = await client.api("conversations.info", {
      channel: normalized.value,
    });
    const channelInfo = isRecord(info) ? info.channel : null;
    const name = isRecord(channelInfo) ? (getString(channelInfo.name) ?? "").trim() : "";
    if (name) {
      return `in:#${name}`;
    }
  } catch {
    // ignore
  }
  return null;
}

export async function resolveUserId(
  client: SlackApiClient,
  input: string,
): Promise<string | undefined> {
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^U[A-Z0-9]{8,}$/.test(trimmed)) {
    return trimmed;
  }
  const name = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;

  let cursor: string | undefined;
  for (;;) {
    const resp = await client.api("users.list", { limit: 200, cursor });
    const members = isRecord(resp) ? asArray(resp.members).filter(isRecord) : [];
    const found = members.find((m) => {
      const mName = getString(m.name);
      const profile = isRecord(m.profile) ? m.profile : null;
      const display = profile ? getString(profile.display_name) : undefined;
      return mName === name || display === name;
    });
    const foundId = found ? getString(found.id) : undefined;
    if (foundId) {
      return foundId;
    }
    const meta = isRecord(resp) ? resp.response_metadata : null;
    const next = isRecord(meta) ? getString(meta.next_cursor) : undefined;
    if (!next) {
      break;
    }
    cursor = next;
  }
  return undefined;
}
