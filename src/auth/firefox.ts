import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  copySqliteForRead,
  listProfileCandidates,
  pickCandidatesByProfile,
  queryReadonlySqlite,
} from "./firefox-profile.ts";

type FirefoxTeam = { url: string; name?: string; token: string };

export type FirefoxExtracted = {
  cookie_d: string;
  teams: FirefoxTeam[];
  source: { profile_path: string; cookies_path: string; localstorage_path: string };
};

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\u0000-\u001F]/g;

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
    const [first] = buf;
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
  const stripped = raw.replace(CONTROL_CHAR_RE, "");
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
  return tryDecode(sliced.replace(CONTROL_CHAR_RE, ""));
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
    const [, name, url, token] = match;
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
