import type { SlackApiClient } from "./client.ts";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
