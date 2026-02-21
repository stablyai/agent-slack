import type { SlackApiClient } from "./client.ts";
import { asArray, getString, isRecord } from "../lib/object-type-guards.ts";

export type ConversationType = "public" | "private" | "group-dm" | "dm";

export type CompactConversation = {
  id: string;
  type: "public" | "private" | "group-dm" | "dm";
  name?: string;
  topic?: string;
  member_count?: number;
  user_id?: string;
};

const TYPE_MAP: Record<ConversationType, string> = {
  public: "public_channel",
  private: "private_channel",
  "group-dm": "mpim",
  dm: "im",
};

const ALL_TYPES: ConversationType[] = ["public", "private", "group-dm", "dm"];

function toCompactConversation(
  raw: Record<string, unknown>,
  type: ConversationType,
): CompactConversation {
  const id = getString(raw.id) ?? "";
  const name = getString(raw.name) ?? undefined;
  const topic = isRecord(raw.topic) ? (getString(raw.topic.value) ?? undefined) : undefined;
  const member_count = typeof raw.num_members === "number" ? raw.num_members : undefined;
  const user_id = type === "dm" ? (getString(raw.user) ?? undefined) : undefined;

  return { id, type, name, topic, member_count, user_id };
}

export async function listConversations(
  client: SlackApiClient,
  options?: {
    types?: ConversationType[];
    limit?: number;
    cursor?: string;
    excludeArchived?: boolean;
  },
): Promise<{ conversations: CompactConversation[]; next_cursor?: string }> {
  const requestedTypes = options?.types?.length ? options.types : ALL_TYPES;
  const limit = Math.min(Math.max(options?.limit ?? 200, 1), 1000);
  const typesParam = requestedTypes.map((t) => TYPE_MAP[t]).join(",");

  const out: CompactConversation[] = [];
  let cursor = options?.cursor;

  while (out.length < limit) {
    const pageSize = Math.min(200, limit - out.length);
    const resp = await client.api("conversations.list", {
      types: typesParam,
      limit: pageSize,
      cursor,
      exclude_archived: options?.excludeArchived ?? false,
    });

    const channels = asArray(resp.channels).filter(isRecord);
    for (const c of channels) {
      const id = getString(c.id);
      if (!id) {
        continue;
      }

      // Determine conversation type from raw flags
      let type: ConversationType;
      if (c.is_mpim) {
        type = "group-dm";
      } else if (c.is_im) {
        type = "dm";
      } else if (c.is_private) {
        type = "private";
      } else {
        type = "public";
      }

      out.push(toCompactConversation(c, type));
      if (out.length >= limit) {
        break;
      }
    }

    const meta = isRecord(resp.response_metadata) ? resp.response_metadata : null;
    const next = meta ? getString(meta.next_cursor) : undefined;
    if (!next) {
      return { conversations: out };
    }
    cursor = next;
  }

  // Enrich DM entries with user display names
  if (requestedTypes.includes("dm")) {
    const dmEntries = out.filter((c) => c.type === "dm" && c.user_id);
    if (dmEntries.length > 0) {
      const userMap = await buildUserDisplayNameMap(client);
      for (const entry of dmEntries) {
        if (entry.user_id) {
          const info = userMap.get(entry.user_id);
          if (info) {
            entry.name = info.display_name ?? info.real_name ?? info.name ?? entry.name;
          }
        }
      }
    }
  }

  return { conversations: out, next_cursor: cursor };
}

async function buildUserDisplayNameMap(
  client: SlackApiClient,
): Promise<Map<string, { name?: string; real_name?: string; display_name?: string }>> {
  const map = new Map<string, { name?: string; real_name?: string; display_name?: string }>();
  let cursor: string | undefined;

  for (;;) {
    const resp = await client.api("users.list", { limit: 200, cursor });
    const members = asArray(resp.members).filter(isRecord);
    for (const m of members) {
      const id = getString(m.id);
      if (!id) {
        continue;
      }
      const profile = isRecord(m.profile) ? m.profile : {};
      map.set(id, {
        name: getString(m.name) ?? undefined,
        real_name: getString(m.real_name) ?? undefined,
        display_name: getString(profile.display_name) ?? undefined,
      });
    }
    const meta = isRecord(resp.response_metadata) ? resp.response_metadata : null;
    const next = meta ? getString(meta.next_cursor) : undefined;
    if (!next) {
      break;
    }
    cursor = next;
  }

  return map;
}
