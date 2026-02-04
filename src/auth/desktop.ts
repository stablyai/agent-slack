import { cp, mkdir, rm, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import { pbkdf2Sync, createDecipheriv } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { ClassicLevel } from "classic-level";

type DesktopTeam = { url: string; name?: string; token: string };

export type DesktopExtracted = {
  cookie_d: string;
  teams: DesktopTeam[];
  source: { leveldb_path: string; cookies_path: string };
};

const SLACK_SUPPORT_DIR = join(
  homedir(),
  "Library",
  "Application Support",
  "Slack",
);
const LEVELDB_DIR = join(SLACK_SUPPORT_DIR, "Local Storage", "leveldb");
const COOKIES_DB = join(SLACK_SUPPORT_DIR, "Cookies");

async function snapshotLevelDb(srcDir: string): Promise<string> {
  const base = join(
    homedir(),
    ".config",
    "agent-slack",
    "cache",
    "leveldb-snapshots",
  );
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

function parseLocalConfig(raw: Buffer): any {
  if (!raw || raw.length === 0) throw new Error("localConfig is empty");

  const first = raw[0];
  const data =
    first === 0x00 || first === 0x01 || first === 0x02 ? raw.subarray(1) : raw;

  let nulCount = 0;
  for (const b of data) if (b === 0) nulCount++;

  const encodings: BufferEncoding[] =
    nulCount > data.length / 4
      ? (["utf16le", "utf8"] as const)
      : (["utf8", "utf16le"] as const);

  let lastErr: any;
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

async function extractTeamsFromSlackLevelDb(
  leveldbDir: string,
): Promise<DesktopTeam[]> {
  if (!existsSync(leveldbDir))
    throw new Error(`Slack LevelDB not found: ${leveldbDir}`);
  const snap = await snapshotLevelDb(leveldbDir);
  const db = new ClassicLevel<Buffer, Buffer>(snap, {
    keyEncoding: "buffer",
    valueEncoding: "buffer",
  });

  try {
    await db.open();
    let configBuf: Buffer | null = null;

    // Fast path: try known Chromium Local Storage key shapes for Slack.
    const candidates: Buffer[] = [];
    for (const versionName of ["localConfig_v2", "localConfig_v3"] as const) {
      for (const prefix of [
        "._https://app.slack.com\x00\x01",
        "_https://app.slack.com\x00\x01",
        "._https://app.slack.com\x00",
        "_https://app.slack.com\x00",
      ]) {
        candidates.push(Buffer.from(`${prefix}${versionName}`));
        candidates.push(Buffer.from(`${prefix}${versionName}\0`));
        candidates.push(Buffer.from(`${prefix}${versionName}\x01`));
      }
    }

    for (const k of candidates) {
      const value = await db.get(k).catch(() => null);
      if (value && value.length > 0) {
        configBuf = value;
        break;
      }
    }

    // Slow fallback: scan keys until we find localConfig.
    if (!configBuf) {
      const localConfigV2 = Buffer.from("localConfig_v2");
      const localConfigV3 = Buffer.from("localConfig_v3");

      const originPrefixes = [
        Buffer.from("._https://app.slack.com"),
        Buffer.from("_https://app.slack.com"),
        Buffer.from("L_https://app.slack.com"),
      ];

      for (const originPrefix of originPrefixes) {
        const upper = Buffer.concat([originPrefix, Buffer.from([0xff])]);
        for await (const [key] of db.iterator({
          gte: originPrefix,
          lte: upper,
          keys: true,
          values: false,
        })) {
          if (key.includes(localConfigV2) || key.includes(localConfigV3)) {
            const value = await db.get(key).catch(() => null);
            if (value && value.length > 0) {
              configBuf = value;
              break;
            }
          }
        }
        if (configBuf) break;
      }
    }

    if (!configBuf)
      throw new Error("Slack LevelDB did not contain localConfig_v2/v3");

    const cfg = parseLocalConfig(configBuf);
    const teamsObj = cfg?.teams ?? {};
    const teams: DesktopTeam[] = Object.values(teamsObj)
      .filter(
        (t: any) => typeof t?.url === "string" && typeof t?.token === "string",
      )
      .map((t: any) => ({ url: t.url, name: t.name, token: t.token }))
      .filter((t) => t.token.startsWith("xoxc-"));

    if (teams.length === 0)
      throw new Error("No xoxc tokens found in Slack localConfig");
    return teams;
  } finally {
    try {
      await db.close();
    } catch {
      // ignore
    }
    try {
      await rm(snap, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

function getSafeStoragePassword(): string {
  const services = [
    "Slack Safe Storage",
    "Chrome Safe Storage",
    "Chromium Safe Storage",
  ];
  for (const svc of services) {
    try {
      const out = execSync(
        `security find-generic-password -w -s ${JSON.stringify(svc)} 2>/dev/null`,
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      ).trim();
      if (out) return out;
    } catch {
      // continue
    }
  }
  throw new Error(
    'Could not read Safe Storage password from Keychain (tried "Slack Safe Storage").',
  );
}

function decryptChromiumCookieValue(
  encrypted: Buffer,
  password: string,
): string {
  if (!encrypted || encrypted.length === 0) return "";

  const prefix = encrypted.subarray(0, 3).toString("utf8");
  const data =
    prefix === "v10" || prefix === "v11" ? encrypted.subarray(3) : encrypted;

  const salt = Buffer.from("saltysalt", "utf8");
  const iv = Buffer.alloc(16, " ");
  const key = pbkdf2Sync(password, salt, 1003, 16, "sha1");

  const decipher = createDecipheriv("aes-128-cbc", key, iv);
  decipher.setAutoPadding(true);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  const marker = Buffer.from("xoxd-");
  const idx = plain.indexOf(marker);
  if (idx === -1) return plain.toString("utf8");

  let end = idx;
  while (end < plain.length) {
    const b = plain[end]!;
    if (b < 0x21 || b > 0x7e) break;
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
  if (!existsSync(cookiesPath))
    throw new Error(`Slack Cookies DB not found: ${cookiesPath}`);
  const db = new Database(cookiesPath, { readonly: true });
  try {
    const rows = db
      .query(
        "select host_key, name, value, encrypted_value from cookies where name = 'd' and host_key like '%slack.com' order by length(encrypted_value) desc",
      )
      .all() as Array<{
      host_key: string;
      name: string;
      value: string;
      encrypted_value: Uint8Array;
    }>;

    if (!rows || rows.length === 0)
      throw new Error("No Slack 'd' cookie found");
    const row = rows[0]!;
    if (row.value && row.value.startsWith("xoxd-")) return row.value;

    const encrypted = Buffer.from(row.encrypted_value || []);
    if (encrypted.length === 0)
      throw new Error("Slack 'd' cookie had no encrypted_value");

    const password = getSafeStoragePassword();
    const decrypted = decryptChromiumCookieValue(encrypted, password);
    const match = decrypted.match(/xoxd-[A-Za-z0-9%/+_=.-]+/);
    if (!match)
      throw new Error("Could not locate xoxd-* in decrypted Slack cookie");
    return match[0]!;
  } finally {
    db.close();
  }
}

export async function extractFromSlackDesktop(): Promise<DesktopExtracted> {
  const teams = await extractTeamsFromSlackLevelDb(LEVELDB_DIR);
  const cookie_d = extractCookieDFromSlackCookiesDb(COOKIES_DB);
  return {
    cookie_d,
    teams,
    source: { leveldb_path: LEVELDB_DIR, cookies_path: COOKIES_DB },
  };
}
