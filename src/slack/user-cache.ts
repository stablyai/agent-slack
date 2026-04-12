import { createHash } from "node:crypto";
import { join } from "node:path";
import { getAppDir } from "../lib/app-dir.ts";
import { readJsonFile, writeJsonFile } from "../lib/fs.ts";
import { asArray, getString, isRecord } from "../lib/object-type-guards.ts";
import type { SlackApiClient } from "./client.ts";
import type { SlackMessageSummary } from "./messages.ts";
import { toCompactUser, type CompactSlackUser } from "./users.ts";

const CACHE_VERSION = 1;
const USER_TTL_MS = 24 * 60 * 60 * 1000;
const USER_ID_PATTERN = /^(U|W)[A-Z0-9]{8,}$/;
const USER_MENTION_PATTERN = /<@((U|W)[A-Z0-9]{8,})(?:\|[^>]+)?>/g;

type UserCacheEntry = {
  fetched_at: number;
  user: CompactSlackUser;
};

type UserCacheFile = {
  version: number;
  entries: Record<string, UserCacheEntry>;
};

export async function resolveUsersById(input: {
  client: SlackApiClient;
  workspaceUrl: string;
  userIds: string[];
  forceRefresh?: boolean;
}): Promise<Map<string, CompactSlackUser>> {
  const uniqueIds = dedupeUserIds(input.userIds);
  if (uniqueIds.length === 0) {
    return new Map<string, CompactSlackUser>();
  }

  const forceRefresh = input.forceRefresh ?? false;
  const now = Date.now();
  const workspaceKey = hashWorkspaceUrl(input.workspaceUrl);
  const isUnknownWorkspace = workspaceKey === "unknown";
  const cachePath = isUnknownWorkspace ? "" : join(getAppDir(), `users-cache-${workspaceKey}.json`);

  const diskCache = cachePath
    ? await loadCache(cachePath)
    : { version: CACHE_VERSION, entries: {} };
  const out = new Map<string, CompactSlackUser>();
  const missing: string[] = [];

  for (const userId of uniqueIds) {
    const cached = diskCache.entries[userId];
    if (!forceRefresh && cached && now - cached.fetched_at < USER_TTL_MS) {
      out.set(userId, cached.user);
      continue;
    }
    missing.push(userId);
  }

  let cacheChanged = false;

  if (missing.length > 0) {
    const fetched: { userId: string; user: CompactSlackUser | undefined }[] = [];
    const concurrency = 5;
    for (let i = 0; i < missing.length; i += concurrency) {
      const chunk = missing.slice(i, i + concurrency);
      const results = await Promise.all(
        chunk.map(async (userId) => ({ userId, user: await fetchUserById(input.client, userId) })),
      );
      fetched.push(...results);
    }

    for (const item of fetched) {
      if (!item.user) {
        continue;
      }
      const entry: UserCacheEntry = {
        fetched_at: now,
        user: item.user,
      };
      diskCache.entries[item.userId] = entry;
      out.set(item.userId, item.user);
      cacheChanged = true;
    }
  }

  if (cachePath) {
    const prunedCache = pruneExpiredEntries(diskCache, now);
    if (Object.keys(diskCache.entries).length !== Object.keys(prunedCache.entries).length) {
      cacheChanged = true;
    }

    if (cacheChanged) {
      await writeCache(cachePath, prunedCache);
    }
  }

  return out;
}

export function collectReferencedUserIds(
  messages: SlackMessageSummary[],
  options?: { includeReactions?: boolean },
): string[] {
  const ids = new Set<string>();
  const includeReactions = options?.includeReactions ?? false;
  for (const message of messages) {
    collectUserIdsFromMessage(message, ids, { includeReactions });
  }
  return Array.from(ids);
}

export function toReferencedUsers(
  userIds: string[],
  usersById: Map<string, CompactSlackUser>,
): Record<string, CompactSlackUser> | undefined {
  const out: Record<string, CompactSlackUser> = {};
  for (const userId of dedupeUserIds(userIds)) {
    const user = usersById.get(userId);
    if (!user) {
      continue;
    }
    out[userId] = user;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function dedupeUserIds(ids: string[]): string[] {
  const seen = new Set<string>();
  for (const raw of ids) {
    const userId = String(raw).trim();
    if (!USER_ID_PATTERN.test(userId)) {
      continue;
    }
    seen.add(userId);
  }
  return Array.from(seen);
}

function hashWorkspaceUrl(workspaceUrl: string): string {
  const trimmed = workspaceUrl.trim();
  if (!trimmed) {
    return "unknown";
  }

  let source = trimmed;
  try {
    source = new URL(trimmed).hostname.toLowerCase();
  } catch {
    source = trimmed.toLowerCase();
  }

  if (!source || source === "unknown") {
    return "unknown";
  }

  return createHash("sha256").update(source).digest("hex").slice(0, 16);
}

async function loadCache(path: string): Promise<UserCacheFile> {
  const file = await readJsonFile<UserCacheFile>(path);
  if (!file || file.version !== CACHE_VERSION || !isRecord(file.entries)) {
    return { version: CACHE_VERSION, entries: {} };
  }

  const entries: Record<string, UserCacheEntry> = {};
  for (const [userId, rawEntry] of Object.entries(file.entries)) {
    if (!USER_ID_PATTERN.test(userId) || !isRecord(rawEntry)) {
      continue;
    }
    const fetchedAt = typeof rawEntry.fetched_at === "number" ? rawEntry.fetched_at : undefined;
    const user = isRecord(rawEntry.user) ? toCompactUser(rawEntry.user) : null;
    if (!fetchedAt || !user) {
      continue;
    }
    entries[userId] = { fetched_at: fetchedAt, user };
  }

  return {
    version: CACHE_VERSION,
    entries,
  };
}

async function writeCache(path: string, file: UserCacheFile): Promise<void> {
  try {
    await writeJsonFile(path, file);
  } catch {
    // Cache writes are best effort.
  }
}

function pruneExpiredEntries(file: UserCacheFile, now: number): UserCacheFile {
  const next: Record<string, UserCacheEntry> = {};
  for (const [userId, entry] of Object.entries(file.entries)) {
    if (now - entry.fetched_at >= USER_TTL_MS) {
      continue;
    }
    next[userId] = entry;
  }
  return { version: CACHE_VERSION, entries: next };
}

async function fetchUserById(
  client: SlackApiClient,
  userId: string,
): Promise<CompactSlackUser | undefined> {
  try {
    const resp = await client.api("users.info", { user: userId });
    const user = isRecord(resp.user) ? resp.user : null;
    if (!user) {
      return undefined;
    }
    return toCompactUser(user);
  } catch {
    return undefined;
  }
}

function collectUserIdsFromUnknown(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    collectMentionUserIds(value, out);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectUserIdsFromUnknown(item, out);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if ((key === "user" || key === "user_id") && typeof child === "string") {
      if (USER_ID_PATTERN.test(child)) {
        out.add(child);
      }
      continue;
    }

    if (key === "users") {
      for (const maybeUserId of asArray(child)) {
        const userId = String(maybeUserId);
        if (USER_ID_PATTERN.test(userId)) {
          out.add(userId);
        }
      }
      continue;
    }

    collectUserIdsFromUnknown(child, out);
  }
}

function collectUserIdsFromMessage(
  message: SlackMessageSummary,
  out: Set<string>,
  options: { includeReactions: boolean },
): void {
  if (message.user && USER_ID_PATTERN.test(message.user)) {
    out.add(message.user);
  }

  if (typeof message.text === "string") {
    collectMentionUserIds(message.text, out);
  }

  collectUserIdsFromUnknown(message.blocks, out);
  collectUserIdsFromUnknown(message.attachments, out);

  if (options.includeReactions) {
    collectUserIdsFromUnknown(message.reactions, out);
  }
}

function collectMentionUserIds(text: string, out: Set<string>): void {
  USER_MENTION_PATTERN.lastIndex = 0;
  for (;;) {
    const match = USER_MENTION_PATTERN.exec(text);
    if (!match) {
      break;
    }
    const userId = match[1] ?? "";
    if (USER_ID_PATTERN.test(userId)) {
      out.add(userId);
    }
  }
}
