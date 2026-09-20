import { createHash } from "node:crypto";
import { join } from "node:path";
import { getAppDir } from "../lib/app-dir.ts";
import { readJsonFile, writeJsonFile } from "../lib/fs.ts";
import { asArray, getString, isRecord } from "../lib/object-type-guards.ts";
import type { SlackApiClient } from "./client.ts";
import type { SlackMessageSummary } from "./messages.ts";
import { toCompactUser, type CompactSlackUser } from "./compact-user.ts";
import { isUserId } from "./user-id.ts";

const CACHE_VERSION = 2;
const USER_TTL_MS = 24 * 60 * 60 * 1000;
const USER_MENTION_PATTERN = /<@([^>|]+)(?:\|[^>]*)?>/g;

export { USER_TTL_MS as USER_CACHE_TTL_MS };

type UserCacheEntry = {
  fetched_at: number;
  user: CompactSlackUser;
};

type UserAliasEntry = {
  user_id: string;
  fetched_at: number;
};

type UserCacheFile = {
  version: number;
  entries: Record<string, UserCacheEntry>;
  aliases: Record<string, UserAliasEntry>;
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

  const diskCache = cachePath ? await loadCache(cachePath) : emptyCache();
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
      upsertUser(diskCache, item.user, now);
      out.set(item.userId, item.user);
      cacheChanged = true;
    }
  }

  if (cachePath) {
    const prunedCache = pruneExpiredEntries(diskCache, now);
    if (
      Object.keys(diskCache.entries).length !== Object.keys(prunedCache.entries).length ||
      Object.keys(diskCache.aliases).length !== Object.keys(prunedCache.aliases).length
    ) {
      cacheChanged = true;
    }

    if (cacheChanged) {
      await writeCache(cachePath, prunedCache);
    }
  }

  return out;
}

export function userCachePath(workspaceUrl: string): string {
  const workspaceKey = hashWorkspaceUrl(workspaceUrl);
  if (workspaceKey === "unknown") {
    return "";
  }
  return join(getAppDir(), `users-cache-${workspaceKey}.json`);
}

export async function lookupCachedUserId(input: {
  workspaceUrl?: string;
  handle?: string;
  email?: string;
}): Promise<string | null> {
  const cachePath = input.workspaceUrl ? userCachePath(input.workspaceUrl) : "";
  if (!cachePath) {
    return null;
  }
  const now = Date.now();
  const diskCache = await loadCache(cachePath);
  for (const key of aliasKeysFromQuery(input)) {
    const alias = diskCache.aliases[key];
    if (!alias) {
      continue;
    }
    if (now - alias.fetched_at >= USER_TTL_MS) {
      continue;
    }
    if (isUserId(alias.user_id)) {
      return alias.user_id;
    }
  }
  return null;
}

export async function indexUsersInCache(input: {
  workspaceUrl?: string;
  users: CompactSlackUser[];
  fetchedAt?: number;
}): Promise<void> {
  const cachePath = input.workspaceUrl ? userCachePath(input.workspaceUrl) : "";
  if (!cachePath || input.users.length === 0) {
    return;
  }
  const now = input.fetchedAt ?? Date.now();
  const diskCache = await loadCache(cachePath);
  let changed = false;
  for (const user of input.users) {
    if (!isUserId(user.id)) {
      continue;
    }
    upsertUser(diskCache, user, now);
    changed = true;
  }
  if (!changed) {
    return;
  }
  await writeCache(cachePath, pruneExpiredEntries(diskCache, now));
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
    if (!isUserId(userId)) {
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

function emptyCache(): UserCacheFile {
  return { version: CACHE_VERSION, entries: {}, aliases: {} };
}

async function loadCache(path: string): Promise<UserCacheFile> {
  const file = await readJsonFile<UserCacheFile>(path);
  if (!file || !isRecord(file.entries) || (file.version !== 1 && file.version !== CACHE_VERSION)) {
    return emptyCache();
  }

  const entries: Record<string, UserCacheEntry> = {};
  for (const [userId, rawEntry] of Object.entries(file.entries)) {
    if (!isUserId(userId) || !isRecord(rawEntry)) {
      continue;
    }
    const fetchedAt = typeof rawEntry.fetched_at === "number" ? rawEntry.fetched_at : undefined;
    const user = isRecord(rawEntry.user) ? toCompactUser(rawEntry.user) : null;
    if (!fetchedAt || !user) {
      continue;
    }
    entries[userId] = { fetched_at: fetchedAt, user };
  }

  const aliases: Record<string, UserAliasEntry> = {};
  if (isRecord(file.aliases)) {
    for (const [alias, rawAlias] of Object.entries(file.aliases)) {
      if (!isRecord(rawAlias)) {
        continue;
      }
      const userId = getString(rawAlias.user_id);
      const fetchedAt = typeof rawAlias.fetched_at === "number" ? rawAlias.fetched_at : undefined;
      if (!userId || !isUserId(userId) || !fetchedAt) {
        continue;
      }
      aliases[alias] = { user_id: userId, fetched_at: fetchedAt };
    }
  } else {
    for (const entry of Object.values(entries)) {
      for (const key of aliasKeysForUser(entry.user)) {
        aliases[key] = { user_id: entry.user.id, fetched_at: entry.fetched_at };
      }
    }
  }

  return {
    version: CACHE_VERSION,
    entries,
    aliases,
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
  const nextEntries: Record<string, UserCacheEntry> = {};
  for (const [userId, entry] of Object.entries(file.entries)) {
    if (now - entry.fetched_at >= USER_TTL_MS) {
      continue;
    }
    nextEntries[userId] = entry;
  }
  const nextAliases: Record<string, UserAliasEntry> = {};
  for (const [alias, entry] of Object.entries(file.aliases)) {
    if (now - entry.fetched_at >= USER_TTL_MS) {
      continue;
    }
    nextAliases[alias] = entry;
  }
  return { version: CACHE_VERSION, entries: nextEntries, aliases: nextAliases };
}

function upsertUser(file: UserCacheFile, user: CompactSlackUser, fetchedAt: number): void {
  file.entries[user.id] = { fetched_at: fetchedAt, user };
  const nextKeys = new Set(aliasKeysForUser(user));
  for (const [alias, entry] of Object.entries(file.aliases)) {
    if (entry.user_id === user.id && !nextKeys.has(alias)) {
      delete file.aliases[alias];
    }
  }
  for (const key of nextKeys) {
    file.aliases[key] = { user_id: user.id, fetched_at: fetchedAt };
  }
}

function aliasKeysForUser(user: CompactSlackUser): string[] {
  const keys: string[] = [];
  const handle = user.name?.trim().toLowerCase();
  if (handle) {
    keys.push(`name:${handle}`);
  }
  const email = user.email?.trim().toLowerCase();
  if (email) {
    keys.push(`email:${email}`);
  }
  return keys;
}

function aliasKeysFromQuery(input: { handle?: string; email?: string }): string[] {
  const keys: string[] = [];
  const handle = input.handle?.trim().replace(/^@/, "").toLowerCase();
  if (handle) {
    keys.push(`name:${handle}`);
  }
  const email = input.email?.trim().toLowerCase();
  if (email) {
    keys.push(`email:${email}`);
  }
  return keys;
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
      if (isUserId(child)) {
        out.add(child);
      }
      continue;
    }

    if (key === "users") {
      for (const maybeUserId of asArray(child)) {
        const userId = String(maybeUserId);
        if (isUserId(userId)) {
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
  if (message.user && isUserId(message.user)) {
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
    if (isUserId(userId)) {
      out.add(userId);
    }
  }
}
