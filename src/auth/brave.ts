import { execSync, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { pbkdf2Sync, createDecipheriv } from "node:crypto";
import { homedir, platform } from "node:os";
import { join } from "node:path";

type BraveExtractedTeam = { url: string; name?: string; token: string };

export type BraveExtracted = {
  cookie_d: string;
  teams: BraveExtractedTeam[];
};

const IS_MACOS = platform() === "darwin";

// --- AppleScript helpers (for extracting teams from Brave tabs) ---

function escapeOsaScript(script: string): string {
  return script.replace(/'/g, `'"'"'`);
}

function osascript(script: string): string {
  return execSync(`osascript -e '${escapeOsaScript(script)}'`, {
    encoding: "utf8",
    timeout: 7000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const TEAM_JSON_PATHS = [
  "JSON.stringify(JSON.parse(localStorage.localConfig_v2).teams)",
  "JSON.stringify(JSON.parse(localStorage.localConfig_v3).teams)",
  "JSON.stringify(JSON.parse(localStorage.getItem('reduxPersist:localConfig'))?.teams || {})",
  "JSON.stringify(window.boot_data?.teams || {})",
];

function teamsScript(): string {
  const tryPaths = TEAM_JSON_PATHS.map(
    (expr) => `try { var v = ${expr}; if (v && v !== '{}' && v !== 'null') return v; } catch(e) {}`,
  );
  return `
    tell application "Brave Browser"
      repeat with w in windows
        repeat with t in tabs of w
          if URL of t contains "slack.com" then
            return execute t javascript "(function(){ ${tryPaths.join(" ")} return '{}'; })()"
          end if
        end repeat
      end repeat
      return "{}"
    end tell
  `;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toBraveTeam(value: unknown): BraveExtractedTeam | null {
  if (!isRecord(value)) {
    return null;
  }
  const token = typeof value.token === "string" ? value.token : null;
  const url = typeof value.url === "string" ? value.url : null;
  if (!token || !url || !token.startsWith("xoxc-")) {
    return null;
  }
  const name = typeof value.name === "string" ? value.name : undefined;
  return { url, name, token };
}

function extractTeamsFromBraveTab(): BraveExtractedTeam[] {
  const teamsRaw = osascript(teamsScript());
  let teamsObj: unknown = {};
  try {
    teamsObj = JSON.parse(teamsRaw || "{}");
  } catch {
    teamsObj = {};
  }

  const teamsRecord = isRecord(teamsObj) ? teamsObj : {};
  return Object.values(teamsRecord)
    .map((t) => toBraveTeam(t))
    .filter((t): t is BraveExtractedTeam => t !== null);
}

// --- Cookie extraction from Brave's SQLite database ---

const BRAVE_COOKIES_DB = join(
  homedir(),
  "Library",
  "Application Support",
  "BraveSoftware",
  "Brave-Browser",
  "Default",
  "Cookies",
);

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

type SqliteRow = Record<string, unknown>;

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

function getSafeStoragePasswords(): string[] {
  const services = [
    "Brave Safe Storage",
    "Brave Browser Safe Storage",
    "Chrome Safe Storage",
    "Chromium Safe Storage",
  ];
  const passwords: string[] = [];
  for (const service of services) {
    try {
      const out = execFileSync("security", ["find-generic-password", "-w", "-s", service], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (out) {
        passwords.push(out);
      }
    } catch {
      // continue
    }
  }
  return passwords;
}

function decryptChromiumCookieValue(data: Buffer, password: string): string {
  if (!data || data.length === 0) {
    return "";
  }

  const salt = Buffer.from("saltysalt", "utf8");
  const iv = Buffer.alloc(16, " ");
  const key = pbkdf2Sync(password, salt, 1003, 16, "sha1");

  const decipher = createDecipheriv("aes-128-cbc", key, iv);
  decipher.setAutoPadding(true);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  const marker = Buffer.from("xoxd-");
  const idx = plain.indexOf(marker);
  if (idx === -1) {
    return plain.toString("utf8");
  }

  let end = idx;
  while (end < plain.length) {
    const b = plain[end]!;
    if (b < 0x21 || b > 0x7e) {
      break;
    }
    end++;
  }
  const rawToken = plain.subarray(idx, end).toString("utf8");
  try {
    return decodeURIComponent(rawToken);
  } catch {
    return rawToken;
  }
}

async function extractCookieDFromBrave(): Promise<string> {
  if (!existsSync(BRAVE_COOKIES_DB)) {
    throw new Error(`Brave Cookies DB not found: ${BRAVE_COOKIES_DB}`);
  }

  const rows = (await queryReadonlySqlite(
    BRAVE_COOKIES_DB,
    "select host_key, name, value, encrypted_value from cookies where name = 'd' and host_key like '%slack.com' order by length(encrypted_value) desc",
  )) as {
    host_key: string;
    name: string;
    value: string;
    encrypted_value: Uint8Array;
  }[];

  if (!rows || rows.length === 0) {
    throw new Error("No Slack 'd' cookie found in Brave");
  }
  const row = rows[0]!;
  if (row.value && row.value.startsWith("xoxd-")) {
    return row.value;
  }

  const encrypted = Buffer.from(row.encrypted_value || []);
  if (encrypted.length === 0) {
    throw new Error("Brave Slack 'd' cookie had no encrypted_value");
  }

  const prefix = encrypted.subarray(0, 3).toString("utf8");
  const data = prefix === "v10" || prefix === "v11" ? encrypted.subarray(3) : encrypted;
  const passwords = getSafeStoragePasswords();

  for (const password of passwords) {
    try {
      const decrypted = decryptChromiumCookieValue(data, password);
      const match = decrypted.match(/xoxd-[A-Za-z0-9%/+_=.-]+/);
      if (match) {
        return match[0]!;
      }
    } catch {
      // continue
    }
  }

  throw new Error("Could not decrypt Slack 'd' cookie from Brave");
}

// --- Main export ---

export async function extractFromBrave(): Promise<BraveExtracted | null> {
  if (!IS_MACOS) {
    return null;
  }
  try {
    const teams = extractTeamsFromBraveTab();
    if (teams.length === 0) {
      return null;
    }

    const cookie_d = await extractCookieDFromBrave();
    if (!cookie_d || !cookie_d.startsWith("xoxd-")) {
      return null;
    }

    return { cookie_d, teams };
  } catch {
    return null;
  }
}
