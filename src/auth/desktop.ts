// Desktop auth extraction approach inspired by:
// - slacktokens: https://github.com/hraftery/slacktokens
import { cp, mkdir, rm, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import { pbkdf2Sync, createDecipheriv } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { findKeysContaining } from "../lib/leveldb-reader.js";

type DesktopTeam = { url: string; name?: string; token: string };

export type DesktopExtracted = {
  cookie_d: string;
  teams: DesktopTeam[];
  source: { leveldb_path: string; cookies_path: string };
};

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

function getSlackPaths(): { leveldbDir: string; cookiesDb: string } {
  const candidates = [SLACK_SUPPORT_DIR_ELECTRON, SLACK_SUPPORT_DIR_APPSTORE];
  for (const dir of candidates) {
    const leveldbDir = join(dir, "Local Storage", "leveldb");
    if (existsSync(leveldbDir)) {
      return { leveldbDir, cookiesDb: join(dir, "Cookies") };
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
  // Hacky but fast on macOS: copy-on-write clone. Falls back to normal copy.
  try {
    execFileSync("cp", ["-cR", srcDir, dest], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
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
    for (const entry of entries) {
      if (entry.key.includes(localConfigV2) || entry.key.includes(localConfigV3)) {
        if (entry.value && entry.value.length > 0) {
          configBuf = entry.value;
          break;
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

function getSafeStoragePassword(): string {
  const services = ["Slack Safe Storage", "Chrome Safe Storage", "Chromium Safe Storage"];
  for (const svc of services) {
    try {
      const out = execSync(
        `security find-generic-password -w -s ${JSON.stringify(svc)} 2>/dev/null`,
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      ).trim();
      if (out) {
        return out;
      }
    } catch {
      // continue
    }
  }
  throw new Error(
    'Could not read Safe Storage password from Keychain (tried "Slack Safe Storage").',
  );
}

function decryptChromiumCookieValue(encrypted: Buffer, password: string): string {
  if (!encrypted || encrypted.length === 0) {
    return "";
  }

  const prefix = encrypted.subarray(0, 3).toString("utf8");
  const data = prefix === "v10" || prefix === "v11" ? encrypted.subarray(3) : encrypted;

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

function extractCookieDFromSlackCookiesDb(cookiesPath: string): string {
  if (!existsSync(cookiesPath)) {
    throw new Error(`Slack Cookies DB not found: ${cookiesPath}`);
  }
  const db = new Database(cookiesPath, { readonly: true });
  try {
    const rows = db
      .query(
        "select host_key, name, value, encrypted_value from cookies where name = 'd' and host_key like '%slack.com' order by length(encrypted_value) desc",
      )
      .all() as {
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

    const password = getSafeStoragePassword();
    const decrypted = decryptChromiumCookieValue(encrypted, password);
    const match = decrypted.match(/xoxd-[A-Za-z0-9%/+_=.-]+/);
    if (!match) {
      throw new Error("Could not locate xoxd-* in decrypted Slack cookie");
    }
    return match[0]!;
  } finally {
    db.close();
  }
}

export async function extractFromSlackDesktop(): Promise<DesktopExtracted> {
  const { leveldbDir, cookiesDb } = getSlackPaths();
  const teams = await extractTeamsFromSlackLevelDb(leveldbDir);
  const cookie_d = extractCookieDFromSlackCookiesDb(cookiesDb);
  return {
    cookie_d,
    teams,
    source: { leveldb_path: leveldbDir, cookies_path: cookiesDb },
  };
}
