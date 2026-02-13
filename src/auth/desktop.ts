// Desktop auth extraction approach inspired by:
// - slacktokens: https://github.com/hraftery/slacktokens
import { cp, mkdir, rm, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pbkdf2Sync, createDecipheriv } from "node:crypto";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { findKeysContaining } from "../lib/leveldb-reader.js";

type SqliteRow = Record<string, unknown>;

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

/**
 * Query a SQLite database in read-only mode.
 * Uses bun:sqlite when running under Bun, falls back to node:sqlite (Node >= 22.5).
 */
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

type DesktopTeam = { url: string; name?: string; token: string };

export type DesktopExtracted = {
  cookie_d: string;
  teams: DesktopTeam[];
  source: { leveldb_path: string; cookies_path: string };
};

const PLATFORM = platform();
const IS_MACOS = PLATFORM === "darwin";
const IS_LINUX = PLATFORM === "linux";

// Electron (direct download) paths
const SLACK_SUPPORT_DIR_ELECTRON = join(homedir(), "Library", "Application Support", "Slack");
// Mac App Store paths (sandboxed container)
const SLACK_SUPPORT_DIR_APPSTORE = join(
  homedir(),
  "Library",
  "Containers",
  "com.tinyspeck.slackmacgap",
  "Data",
  "Library",
  "Application Support",
  "Slack",
);

const SLACK_SUPPORT_DIR_LINUX = join(homedir(), ".config", "Slack");

const SLACK_SUPPORT_DIR_LINUX_FLATPAK = join(
  homedir(),
  ".var",
  "app",
  "com.slack.Slack",
  "config",
  "Slack",
);

function getSlackPaths(): { leveldbDir: string; cookiesDb: string } {
  const candidates = IS_MACOS
    ? [SLACK_SUPPORT_DIR_ELECTRON, SLACK_SUPPORT_DIR_APPSTORE]
    : IS_LINUX
      ? [SLACK_SUPPORT_DIR_LINUX_FLATPAK, SLACK_SUPPORT_DIR_LINUX]
      : [];

  if (candidates.length === 0) {
    throw new Error(`Slack Desktop extraction is not supported on ${PLATFORM}.`);
  }

  for (const dir of candidates) {
    const leveldbDir = join(dir, "Local Storage", "leveldb");
    if (existsSync(leveldbDir)) {
      const cookiesDbCandidates = [join(dir, "Network", "Cookies"), join(dir, "Cookies")];
      const cookiesDb =
        cookiesDbCandidates.find((candidate) => existsSync(candidate)) || cookiesDbCandidates[0]!;
      return { leveldbDir, cookiesDb };
    }
  }

  throw new Error(
    `Slack Desktop data not found. Checked:\n  - ${candidates.map((d) => join(d, "Local Storage", "leveldb")).join("\n  - ")}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toDesktopTeam(value: unknown): DesktopTeam | null {
  if (!isRecord(value)) {
    return null;
  }
  const url = typeof value.url === "string" ? value.url : null;
  const token = typeof value.token === "string" ? value.token : null;
  if (!url || !token) {
    return null;
  }
  const name = typeof value.name === "string" ? value.name : undefined;
  return { url, name, token };
}

async function snapshotLevelDb(srcDir: string): Promise<string> {
  const base = join(homedir(), ".config", "agent-slack", "cache", "leveldb-snapshots");
  const dest = join(base, `${Date.now()}`);
  await mkdir(base, { recursive: true });
  let useNodeCopy = !IS_MACOS;
  if (IS_MACOS) {
    try {
      execFileSync("cp", ["-cR", srcDir, dest], {
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      useNodeCopy = true;
    }
  }
  if (useNodeCopy) {
    await cp(srcDir, dest, { recursive: true, force: true });
  }

  try {
    await unlink(join(dest, "LOCK"));
  } catch {
    // ignore
  }
  return dest;
}

function parseLocalConfig(raw: Buffer): unknown {
  if (!raw || raw.length === 0) {
    throw new Error("localConfig is empty");
  }

  const [first] = raw;
  const data = first === 0x00 || first === 0x01 || first === 0x02 ? raw.subarray(1) : raw;

  let nulCount = 0;
  for (const b of data) {
    if (b === 0) {
      nulCount++;
    }
  }

  const encodings: BufferEncoding[] =
    nulCount > data.length / 4 ? (["utf16le", "utf8"] as const) : (["utf8", "utf16le"] as const);

  let lastErr: unknown;
  for (const enc of encodings) {
    try {
      const text = data.toString(enc);
      try {
        return JSON.parse(text);
      } catch (err1) {
        lastErr = err1;
      }

      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start !== -1 && end !== -1 && end > start) {
        try {
          return JSON.parse(text.slice(start, end + 1));
        } catch (err2) {
          lastErr = err2;
        }
      }
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr || new Error("localConfig not parseable");
}

async function extractTeamsFromSlackLevelDb(leveldbDir: string): Promise<DesktopTeam[]> {
  if (!existsSync(leveldbDir)) {
    throw new Error(`Slack LevelDB not found: ${leveldbDir}`);
  }

  const snap = await snapshotLevelDb(leveldbDir);

  try {
    // Use pure JS LevelDB reader - search for localConfig entries
    const localConfigV2 = Buffer.from("localConfig_v2");
    const localConfigV3 = Buffer.from("localConfig_v3");

    const entries = await findKeysContaining(snap, Buffer.from("localConfig_v"));

    let configBuf: Buffer | null = null;
    let configRank = -1n;
    for (const entry of entries) {
      if (entry.key.includes(localConfigV2) || entry.key.includes(localConfigV3)) {
        if (entry.value && entry.value.length > 0) {
          let rank = 0n;
          if (entry.key.length >= 8) {
            rank = entry.key.readBigUInt64LE(entry.key.length - 8);
          }
          if (!configBuf || rank >= configRank) {
            configBuf = entry.value;
            configRank = rank;
          }
        }
      }
    }

    if (!configBuf) {
      throw new Error("Slack LevelDB did not contain localConfig_v2/v3");
    }

    const cfg = parseLocalConfig(configBuf);
    const teamsValue = isRecord(cfg) ? cfg.teams : undefined;
    const teamsObj = isRecord(teamsValue) ? teamsValue : {};
    const teams: DesktopTeam[] = Object.values(teamsObj)
      .map((t) => toDesktopTeam(t))
      .filter((t): t is DesktopTeam => t !== null)
      .filter((t) => t.token.startsWith("xoxc-"));

    if (teams.length === 0) {
      throw new Error("No xoxc tokens found in Slack localConfig");
    }
    return teams;
  } finally {
    try {
      await rm(snap, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

function getSafeStoragePasswords(prefix: string): string[] {
  if (IS_MACOS) {
    const services = ["Slack Safe Storage", "Chrome Safe Storage", "Chromium Safe Storage"];
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
    if (passwords.length > 0) {
      return passwords;
    }
  }

  if (IS_LINUX) {
    const attributes: string[][] = [
      ["application", "com.slack.Slack"],
      ["application", "Slack"],
      ["application", "slack"],
      ["service", "Slack Safe Storage"],
    ];
    const passwords: string[] = [];
    for (const pair of attributes) {
      try {
        const out = execFileSync("secret-tool", ["lookup", ...pair], {
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

    // Chromium Linux OSCrypt v10 fallback password (see os_crypt_linux.cc).
    if (prefix === "v11") {
      passwords.push("");
    }
    passwords.push("peanuts");

    return [...new Set(passwords)];
  }

  throw new Error("Could not read Safe Storage password from desktop keychain.");
}

function decryptChromiumCookieValue(data: Buffer, password: string): string {
  if (!data || data.length === 0) {
    return "";
  }

  const salt = Buffer.from("saltysalt", "utf8");
  const iv = Buffer.alloc(16, " ");
  const key = pbkdf2Sync(password, salt, IS_LINUX ? 1 : 1003, 16, "sha1");

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

async function extractCookieDFromSlackCookiesDb(cookiesPath: string): Promise<string> {
  if (!existsSync(cookiesPath)) {
    throw new Error(`Slack Cookies DB not found: ${cookiesPath}`);
  }

  const rows = (await queryReadonlySqlite(
    cookiesPath,
    "select host_key, name, value, encrypted_value from cookies where name = 'd' and host_key like '%slack.com' order by length(encrypted_value) desc",
  )) as {
    host_key: string;
    name: string;
    value: string;
    encrypted_value: Uint8Array;
  }[];

  if (!rows || rows.length === 0) {
    throw new Error("No Slack 'd' cookie found");
  }
  const row = rows[0]!;
  if (row.value && row.value.startsWith("xoxd-")) {
    return row.value;
  }

  const encrypted = Buffer.from(row.encrypted_value || []);
  if (encrypted.length === 0) {
    throw new Error("Slack 'd' cookie had no encrypted_value");
  }

  const prefix = encrypted.subarray(0, 3).toString("utf8");
  const data = prefix === "v10" || prefix === "v11" ? encrypted.subarray(3) : encrypted;
  const passwords = getSafeStoragePasswords(prefix);

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

  throw new Error("Could not locate xoxd-* in decrypted Slack cookie");
}

export async function extractFromSlackDesktop(): Promise<DesktopExtracted> {
  const { leveldbDir, cookiesDb } = getSlackPaths();
  const teams = await extractTeamsFromSlackLevelDb(leveldbDir);
  const cookie_d = await extractCookieDFromSlackCookiesDb(cookiesDb);
  return {
    cookie_d,
    teams,
    source: { leveldb_path: leveldbDir, cookies_path: cookiesDb },
  };
}
