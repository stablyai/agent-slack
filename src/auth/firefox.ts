import { copyFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir, platform } from "node:os";
import { join } from "node:path";

type SqliteRow = Record<string, unknown>;

type FirefoxTeam = { url: string; name?: string; token: string };

type ProfileCandidate = {
  name?: string;
  path: string;
  isDefault: boolean;
};

export type FirefoxExtracted = {
  cookie_d: string;
  teams: FirefoxTeam[];
  source: { profile_path: string; cookies_path: string; localstorage_path: string };
};

const PLATFORM = platform();
const IS_MACOS = PLATFORM === "darwin";
const IS_LINUX = PLATFORM === "linux";

function isMissingBunSqliteModule(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const err = error as { code?: unknown; message?: unknown };
  const code = typeof err.code === "string" ? err.code : "";
  const message = typeof err.message === "string" ? err.message : "";

  if (code === "ERR_MODULE_NOT_FOUND" || code === "ERR_UNSUPPORTED_ESM_URL_SCHEME") {
    return true;
  }
  if (!message.includes("bun:sqlite")) {
    return false;
  }
  return (
    message.includes("Cannot find module") ||
    message.includes("Unknown builtin module") ||
    message.includes("unsupported URL scheme") ||
    message.includes("Only URLs with a scheme in")
  );
}

async function queryReadonlySqlite(dbPath: string, sql: string): Promise<SqliteRow[]> {
  try {
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath, { readonly: true });
    try {
      return db.query(sql).all() as SqliteRow[];
    } finally {
      db.close();
    }
  } catch (error) {
    if (!isMissingBunSqliteModule(error)) {
      throw error;
    }
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return db.prepare(sql).all() as SqliteRow[];
    } finally {
      db.close();
    }
  }
}

function getFirefoxBaseDir(): string {
  if (IS_LINUX) {
    return join(homedir(), ".mozilla", "firefox");
  }
  if (IS_MACOS) {
    return join(homedir(), "Library", "Application Support", "Firefox");
  }
  throw new Error(`Firefox extraction is not supported on ${PLATFORM}.`);
}

function parseProfilesIni(raw: string, baseDir: string): ProfileCandidate[] {
  const lines = raw.split(/\r?\n/);
  const profiles: {
    name?: string;
    path?: string;
    isRelative: boolean;
    isDefault: boolean;
  }[] = [];
  // Firefox can mark defaults either in [Profile*] (Default=1) or [Install*] sections.
  const installDefaults = new Set<string>();

  let section = "";
  let current: { name?: string; path?: string; isRelative: boolean; isDefault: boolean } | null =
    null;

  for (const lineRaw of lines) {
    const line = lineRaw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      if (current) {
        profiles.push(current);
        current = null;
      }
      section = line.slice(1, -1);
      if (section.startsWith("Profile")) {
        current = { isRelative: true, isDefault: false };
      }
      continue;
    }

    const idx = line.indexOf("=");
    if (idx === -1) {
      continue;
    }
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();

    if (section.startsWith("Profile") && current) {
      if (key === "Name") {
        current.name = value;
      } else if (key === "Path") {
        current.path = value;
      } else if (key === "IsRelative") {
        current.isRelative = value !== "0";
      } else if (key === "Default") {
        current.isDefault = value === "1";
      }
      continue;
    }

    if (section.startsWith("Install") && key === "Default" && value) {
      installDefaults.add(value);
    }
  }

  if (current) {
    profiles.push(current);
  }

  return profiles
    .filter((p) => Boolean(p.path))
    .map((p) => {
      const profilePath = p.isRelative ? join(baseDir, p.path!) : p.path!;
      return {
        name: p.name,
        path: profilePath,
        isDefault: p.isDefault || installDefaults.has(p.path!),
      };
    });
}

async function listProfileCandidates(): Promise<ProfileCandidate[]> {
  const baseDir = getFirefoxBaseDir();
  const iniPath = join(baseDir, "profiles.ini");
  const candidates: ProfileCandidate[] = [];

  if (existsSync(iniPath)) {
    const raw = await readFile(iniPath, "utf8");
    candidates.push(...parseProfilesIni(raw, baseDir));
  }

  // profiles.ini can be stale, so also scan profile directories as a fallback source.
  const dirName = IS_MACOS ? "Profiles" : baseDir;
  if (existsSync(dirName)) {
    const entries = await readdir(dirName, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const profilePath = join(dirName, entry.name);
      if (!candidates.some((c) => c.path === profilePath)) {
        candidates.push({ path: profilePath, isDefault: false });
      }
    }
  }

  const existing = candidates.filter((c) => existsSync(c.path));
  existing.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  return existing;
}

function pickCandidatesByProfile(
  candidates: ProfileCandidate[],
  profile?: string,
): ProfileCandidate[] {
  const selector = profile?.trim();
  if (!selector) {
    return candidates;
  }
  const normalized = selector.toLowerCase();
  const matched = candidates.filter((c) => {
    const name = c.name?.toLowerCase() ?? "";
    const base = c.path.split("/").pop()?.toLowerCase() ?? "";
    const full = c.path.toLowerCase();
    return name === normalized || base === normalized || full.includes(normalized);
  });
  return matched;
}

async function copySqliteForRead(
  dbPath: string,
): Promise<{ copyPath: string; cleanup: () => Promise<void> }> {
  const tmpPath = await mkdtemp(join(tmpdir(), "agent-slack-firefox-"));
  const base = dbPath.split("/").pop() || "db.sqlite";
  const copyPath = join(tmpPath, base);
  await copyFile(dbPath, copyPath);

  // Firefox keeps recent commits in WAL/SHM while running; copy them with the DB snapshot.
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${dbPath}${suffix}`;
    if (!existsSync(sidecar)) {
      continue;
    }
    try {
      await copyFile(sidecar, `${copyPath}${suffix}`);
    } catch {}
  }

  return {
    copyPath,
    cleanup: async () => {
      try {
        await rm(tmpPath, { recursive: true, force: true });
      } catch {}
    },
  };
}

function toStringValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Uint8Array) {
    // localStorage blobs may include codec marker bytes and mixed UTF-8/UTF-16 payloads.
    const buf = Buffer.from(value);
    const strings: string[] = [];
    strings.push(buf.toString("utf8"));
    strings.push(buf.toString("utf16le"));
    const first = buf[0];
    if (first === 0x00 || first === 0x01 || first === 0x02) {
      const sliced = buf.subarray(1);
      strings.push(sliced.toString("utf8"));
      strings.push(sliced.toString("utf16le"));
    }
    return strings.sort((a, b) => b.length - a.length)[0] ?? "";
  }
  return String(value ?? "");
}

function parseJsonObjectFromValue(value: unknown): Record<string, unknown> | null {
  const raw = toStringValue(value);
  if (!raw) {
    return null;
  }

  const tryDecode = (text: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {}
    return null;
  };

  const direct = tryDecode(raw);
  if (direct) {
    return direct;
  }

  // Control characters sometimes appear around serialized JSON in Firefox storage blobs.
  const stripped = raw.replace(/[\u0000-\u001F]/g, "");
  const strippedDirect = tryDecode(stripped);
  if (strippedDirect) {
    return strippedDirect;
  }

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  const sliced = raw.slice(start, end + 1);
  const slicedDirect = tryDecode(sliced);
  if (slicedDirect) {
    return slicedDirect;
  }
  return tryDecode(sliced.replace(/[\u0000-\u001F]/g, ""));
}

function toFirefoxTeam(value: unknown): FirefoxTeam | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const url = typeof record.url === "string" ? record.url : null;
  const token = typeof record.token === "string" ? record.token : null;
  if (!url || !token || !token.startsWith("xoxc-")) {
    return null;
  }
  const name = typeof record.name === "string" ? record.name : undefined;
  return { url, name, token };
}

function extractTeamsFromRawText(raw: string): FirefoxTeam[] {
  const teams: FirefoxTeam[] = [];
  const seen = new Set<string>();

  // Fallback for partially damaged JSON: recover token/url/name triplets from raw text.
  const richPattern =
    /"name":"([^"]+)".*?"url":"(https:\/\/[^"\s]+slack\.com\/)".*?"token":"(xoxc-[^"]+)"/gs;
  for (const match of raw.matchAll(richPattern)) {
    const name = match[1];
    const url = match[2];
    const token = match[3];
    if (!name || !url || !token) {
      continue;
    }
    const key = `${url}::${token}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    teams.push({ name, url, token });
  }

  if (teams.length > 0) {
    return teams;
  }

  const urls = Array.from(raw.matchAll(/"url":"(https:\/\/[^"\s]+slack\.com\/)"/g)).map(
    (m) => m[1]!,
  );
  const tokens = Array.from(raw.matchAll(/"token":"(xoxc-[^"]+)"/g)).map((m) => m[1]!);
  const count = Math.min(urls.length, tokens.length);
  for (let i = 0; i < count; i++) {
    const url = urls[i];
    const token = tokens[i];
    if (!url || !token) {
      continue;
    }
    const key = `${url}::${token}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    teams.push({ url, token });
  }

  return teams;
}

function getLocalStorageDirs(profilePath: string): string[] {
  const roots = [join(profilePath, "storage", "default")];
  const candidates: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) {
      continue;
    }
    candidates.push(join(root, "https+++app.slack.com", "ls"));
  }
  return candidates;
}

async function extractTeamsFromProfile(
  profilePath: string,
): Promise<{ teams: FirefoxTeam[]; sourcePath: string } | null> {
  const lsDirs = getLocalStorageDirs(profilePath);
  for (const lsDir of lsDirs) {
    const dbPath = join(lsDir, "data.sqlite");
    if (!existsSync(dbPath)) {
      continue;
    }

    const copied = await copySqliteForRead(dbPath);
    try {
      const rows = (await queryReadonlySqlite(
        copied.copyPath,
        "select key, value from data where key in ('localConfig_v2', 'localConfig_v3') order by key desc",
      )) as { key: string; value: unknown }[];

      for (const row of rows) {
        const cfg = parseJsonObjectFromValue(row.value);
        const teamsRaw =
          cfg && typeof cfg.teams === "object" && cfg.teams !== null ? cfg.teams : {};
        const parsedTeams = Object.values(teamsRaw)
          .map((t) => toFirefoxTeam(t))
          .filter((t): t is FirefoxTeam => t !== null);
        if (parsedTeams.length > 0) {
          return { teams: parsedTeams, sourcePath: dbPath };
        }

        const rawTeams = extractTeamsFromRawText(toStringValue(row.value));
        if (rawTeams.length > 0) {
          return { teams: rawTeams, sourcePath: dbPath };
        }
      }
    } finally {
      await copied.cleanup();
    }
  }
  return null;
}

async function extractCookieDFromProfile(
  profilePath: string,
): Promise<{ cookie_d: string; sourcePath: string } | null> {
  const dbPath = join(profilePath, "cookies.sqlite");
  if (!existsSync(dbPath)) {
    return null;
  }

  const copied = await copySqliteForRead(dbPath);
  try {
    const rows = (await queryReadonlySqlite(
      copied.copyPath,
      "select value from moz_cookies where host like '%slack.com%' and name='d' order by length(value) desc",
    )) as { value: string }[];

    for (const row of rows) {
      if (row.value?.startsWith("xoxd-")) {
        return { cookie_d: decodeFirefoxCookieValue(row.value), sourcePath: dbPath };
      }
    }
  } finally {
    await copied.cleanup();
  }

  return null;
}

function decodeFirefoxCookieValue(cookie: string): string {
  let current = cookie;
  // Firefox can persist cookie values in percent-encoded form; normalize before storage.
  for (let i = 0; i < 3; i += 1) {
    try {
      const next = decodeURIComponent(current);
      if (next === current) {
        break;
      }
      current = next;
    } catch {
      break;
    }
  }
  return current;
}

export async function extractFromFirefox(input?: {
  profile?: string;
}): Promise<FirefoxExtracted | null> {
  // Profile selection flow (in order):
  // 1) Build candidates from profiles.ini and directory scan, with defaults first.
  // 2) Apply optional user selector (exact profile name, exact dir basename, or path substring).
  // 3) Walk candidates in that order and require BOTH artifacts from the same profile:
  //    - teams/tokens from local storage
  //    - xoxd cookie from cookies.sqlite
  // 4) Return the first profile that has both; otherwise return null.
  // This keeps behavior deterministic while preferring the active/default profile when possible,
  // but still allows fallback to another profile that has a complete Slack auth state.
  const allCandidates = await listProfileCandidates();
  const candidates = pickCandidatesByProfile(allCandidates, input?.profile);
  if (candidates.length === 0) {
    return null;
  }

  for (const candidate of candidates) {
    const teamsResult = await extractTeamsFromProfile(candidate.path);
    if (!teamsResult) {
      continue;
    }
    const cookieResult = await extractCookieDFromProfile(candidate.path);
    if (!cookieResult) {
      continue;
    }
    return {
      cookie_d: cookieResult.cookie_d,
      teams: teamsResult.teams,
      source: {
        profile_path: candidate.path,
        cookies_path: cookieResult.sourcePath,
        localstorage_path: teamsResult.sourcePath,
      },
    };
  }

  return null;
}
