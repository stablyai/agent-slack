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
  if (isChannelId(trimmed)) return { kind: "id", value: trimmed };
  return { kind: "name", value: trimmed };
}

export async function resolveChannelId(
  client: SlackApiClient,
  input: string,
): Promise<string> {
  const normalized = normalizeChannelInput(input);
  if (normalized.kind === "id") return normalized.value;

  const name = normalized.value;
  if (!name) throw new Error("Channel name is empty");

  let cursor: string | undefined;
  const matches: Array<{ id: string; name?: string; is_private?: boolean }> =
    [];
  for (;;) {
    const resp = await client.api("conversations.list", {
      exclude_archived: true,
      limit: 200,
      cursor,
      types: "public_channel,private_channel",
    });
    const chans = (resp.channels ?? []) as any[];
    for (const c of chans) {
      if (c?.name === name && c?.id) {
        matches.push({
          id: String(c.id),
          name: c.name ? String(c.name) : undefined,
          is_private:
            typeof c.is_private === "boolean" ? c.is_private : undefined,
        });
      }
    }

    const next = resp.response_metadata?.next_cursor;
    if (!next) break;
    cursor = next;
  }

  if (matches.length === 1) return matches[0]!.id;
  if (matches.length === 0) throw new Error(`Could not resolve channel name: #${name}`);

  throw new Error(
    `Ambiguous channel name: #${name} (matched ${matches.length} channels: ${matches
      .map((m) => m.id)
      .join(", ")})`,
  );
}
