import type { SlackApiClient } from "./client.ts";

const DEFAULT_CONVERSATION_TYPES = "public_channel,private_channel,im,mpim";

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

  let cursor: string | undefined;
  const matches: { id: string; name?: string; is_private?: boolean }[] = [];
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
        matches.push({
          id: getString(c.id) ?? "",
          name: getString(c.name) ?? undefined,
          is_private: typeof c.is_private === "boolean" ? c.is_private : undefined,
        });
      }
    }

    const meta = isRecord(resp.response_metadata) ? resp.response_metadata : null;
    const next = meta ? getString(meta.next_cursor) : undefined;
    if (!next) {
      break;
    }
    cursor = next;
  }

  if (matches.length === 1) {
    return matches[0]!.id;
  }
  if (matches.length === 0) {
    throw new Error(`Could not resolve channel name: #${name}`);
  }

  throw new Error(
    `Ambiguous channel name: #${name} (matched ${matches.length} channels: ${matches
      .map((m) => m.id)
      .join(", ")})`,
  );
}

export type ConversationsPage = {
  channels: Record<string, unknown>[];
  next_cursor?: string;
};

type ListConversationsOptions = {
  limit?: number;
  cursor?: string;
  types?: string;
  excludeArchived?: boolean;
};

export async function listUserConversations(
  client: SlackApiClient,
  options?: ListConversationsOptions & { user?: string },
): Promise<ConversationsPage> {
  const resp = await client.api("users.conversations", {
    user: options?.user,
    limit: normalizeLimit(options?.limit),
    cursor: options?.cursor,
    types: options?.types ?? DEFAULT_CONVERSATION_TYPES,
    exclude_archived: options?.excludeArchived ?? true,
  });
  return normalizeConversationsPage(resp);
}

export async function listAllConversations(
  client: SlackApiClient,
  options?: ListConversationsOptions,
): Promise<ConversationsPage> {
  const resp = await client.api("conversations.list", {
    limit: normalizeLimit(options?.limit),
    cursor: options?.cursor,
    types: options?.types ?? DEFAULT_CONVERSATION_TYPES,
    exclude_archived: options?.excludeArchived ?? true,
  });
  return normalizeConversationsPage(resp);
}

export function normalizeConversationsPage(resp: Record<string, unknown>): ConversationsPage {
  const channels = asArray(resp.channels).filter(isRecord);
  const meta = isRecord(resp.response_metadata) ? resp.response_metadata : null;
  const next = meta ? getString(meta.next_cursor) : undefined;
  return { channels, next_cursor: next };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeLimit(value: number | undefined): number {
  return Math.min(Math.max(value ?? 100, 10), 1000);
}
