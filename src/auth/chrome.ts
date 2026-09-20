import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { queryReadonlySqlite } from "./firefox-profile.ts";
import { decryptChromiumCookieValue } from "./chromium-cookie.ts";
import { getKeychainTimeoutMs } from "./keychain.ts";
import { isRecord } from "../lib/object-type-guards.ts";

type ChromeExtractedTeam = { url: string; name?: string; token: string };

export type ChromeExtracted = {
  cookie_d: string;
  teams: ChromeExtractedTeam[];
};

const IS_MACOS = platform() === "darwin";

// Chrome ships with `Allow JavaScript from Apple Events` OFF. Without it,
// `execute javascript` from osascript fails, and that is how this module reads
// `localStorage.localConfig_v2` out of a Slack tab.
export class ChromeAppleScriptDisabledError extends Error {
  constructor() {
    super(
      "Chrome is blocking JavaScript from Apple Events.\n" +
        "Enable it: Chrome menu → View → Developer → Allow JavaScript from Apple Events\n" +
        "Then re-run: agent-slack auth import-chrome",
    );
    this.name = "ChromeAppleScriptDisabledError";
  }
}

// macOS gates Apple events behind per-app Automation consent. A denied or
// never-prompted terminal gets -1743 with no visible prompt.
export class ChromeAutomationNotAuthorizedError extends Error {
  constructor() {
    super(
      "This terminal is not authorized to send Apple events to Google Chrome.\n" +
        "Allow it: System Settings → Privacy & Security → Automation → <your terminal> → Google Chrome\n" +
        "Then re-run: agent-slack auth import-chrome",
    );
    this.name = "ChromeAutomationNotAuthorizedError";
  }
}

export class ChromeNoSlackTabError extends Error {
  constructor() {
    super(
      "No Slack tab found in Google Chrome.\n" +
        "Open your workspace in Chrome (for Enterprise Grid use the workspace URL, " +
        "e.g. https://<workspace>.slack.com, not the https://<org>.enterprise.slack.com shell), " +
        "sign in, then re-run: agent-slack auth import-chrome",
    );
    this.name = "ChromeNoSlackTabError";
  }
}

// Chrome 127+ on macOS/Windows can wrap cookie values with App-Bound
// Encryption (`v20`), which the Safe Storage keychain password cannot open.
export class ChromeAppBoundEncryptionError extends Error {
  constructor() {
    super(
      "Chrome encrypted the Slack cookie with App-Bound Encryption (v20), which cannot be decrypted outside Chrome.\n" +
        "Use another import path instead: agent-slack auth import-desktop (Slack app), " +
        "auth import-brave, or auth import-firefox.",
    );
    this.name = "ChromeAppBoundEncryptionError";
  }
}

// --- AppleScript helpers (for extracting teams from Chrome tabs) ---

const APPLESCRIPT_JS_DISABLED_MARKER = "Executing JavaScript through AppleScript is turned off";
const APPLESCRIPT_NOT_AUTHORIZED_MARKER = "-1743";
const NO_SLACK_TAB_SENTINEL = "__AGENT_SLACK_NO_TAB__";

function osascript(script: string): string {
  try {
    return execFileSync("osascript", ["-e", script], {
      encoding: "utf8",
      timeout: 7000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err: unknown) {
    const stderr =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr: unknown }).stderr ?? "")
        : "";
    const message = err instanceof Error ? err.message : String(err);
    const combined = `${stderr}\n${message}`;
    if (combined.includes(APPLESCRIPT_JS_DISABLED_MARKER)) {
      throw new ChromeAppleScriptDisabledError();
    }
    if (combined.includes(APPLESCRIPT_NOT_AUTHORIZED_MARKER)) {
      throw new ChromeAutomationNotAuthorizedError();
    }
    throw err;
  }
}

const TEAM_JSON_PATHS = [
  // Current known storage
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
    tell application "Google Chrome"
      repeat with w in windows
        repeat with t in tabs of w
          if URL of t contains "slack.com" then
            return execute t javascript "(function(){ ${tryPaths.join(" ")} return '{}'; })()"
          end if
        end repeat
      end repeat
      return "${NO_SLACK_TAB_SENTINEL}"
    end tell
  `;
}

function toChromeTeam(value: unknown): ChromeExtractedTeam | null {
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

export function parseChromeTeams(teamsRaw: string): ChromeExtractedTeam[] {
  if (teamsRaw.includes(NO_SLACK_TAB_SENTINEL)) {
    throw new ChromeNoSlackTabError();
  }

  let teamsObj: unknown = {};
  try {
    teamsObj = JSON.parse(teamsRaw || "{}");
  } catch {
    teamsObj = {};
  }

  const teamsRecord = isRecord(teamsObj) ? teamsObj : {};
  return Object.values(teamsRecord)
    .map((t) => toChromeTeam(t))
    .filter((t): t is ChromeExtractedTeam => t !== null);
}

function extractTeamsFromChromeTab(): ChromeExtractedTeam[] {
  return parseChromeTeams(osascript(teamsScript()));
}

// --- Cookie extraction from Chrome's SQLite database ---
//
// The Slack `d` cookie is HttpOnly, so `document.cookie` in the page context
// never sees it. It has to come from Chrome's cookie store, decrypted with the
// `Chrome Safe Storage` keychain password.

const CHROME_USER_DATA_DIR = join(homedir(), "Library", "Application Support", "Google", "Chrome");

export function getChromeProfileDirs(userDataDir: string): string[] {
  const profiles: string[] = [];
  if (existsSync(join(userDataDir, "Default"))) {
    profiles.push("Default");
  }
  try {
    for (const entry of readdirSync(userDataDir).sort()) {
      if (/^Profile \d+$/.test(entry)) {
        profiles.push(entry);
      }
    }
  } catch {
    // user data dir may not exist
  }
  return profiles;
}

export function getChromeCookieDbPaths(userDataDir: string): string[] {
  const paths: string[] = [];
  for (const profile of getChromeProfileDirs(userDataDir)) {
    for (const candidate of [
      join(userDataDir, profile, "Network", "Cookies"),
      join(userDataDir, profile, "Cookies"),
    ]) {
      if (existsSync(candidate)) {
        paths.push(candidate);
      }
    }
  }
  return paths;
}

function getChromeSafeStoragePasswords(): string[] {
  const services = ["Chrome Safe Storage", "Chromium Safe Storage"];
  const passwords: string[] = [];
  for (const service of services) {
    try {
      const out = execFileSync("security", ["find-generic-password", "-w", "-s", service], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: getKeychainTimeoutMs(),
      }).trim();
      if (out) {
        passwords.push(out);
      }
    } catch {
      // continue
    }
  }
  return [...new Set(passwords)];
}

export type ChromeCookieRow = {
  host_key: string;
  name: string;
  value: string;
  encrypted_value: Uint8Array;
};

/**
 * Decrypt one Chrome cookie row into an `xoxd-*` token.
 *
 * Exported for tests; throws `ChromeAppBoundEncryptionError` on `v20` values.
 */
export function decryptSlackCookieRow(row: ChromeCookieRow, passwords: string[]): string | null {
  if (row.value && row.value.startsWith("xoxd-")) {
    return row.value;
  }

  const encrypted = Buffer.from(row.encrypted_value || []);
  if (encrypted.length === 0) {
    return null;
  }

  const prefix = encrypted.subarray(0, 3).toString("utf8");
  if (prefix === "v20") {
    throw new ChromeAppBoundEncryptionError();
  }

  const data = prefix === "v10" || prefix === "v11" ? encrypted.subarray(3) : encrypted;
  for (const password of passwords) {
    try {
      const decrypted = decryptChromiumCookieValue(data, { password, iterations: 1003 });
      const match = decrypted.match(/xoxd-[A-Za-z0-9%/+_=.-]+/);
      if (match) {
        return match[0]!;
      }
    } catch {
      // continue
    }
  }
  return null;
}

/**
 * Read Chrome's cookie DB through a copy.
 *
 * Chrome keeps the live DB open, so a readonly handle on it can fail or miss
 * writes still sitting in the write-ahead log. Copying `Cookies` plus its
 * `-wal`/`-shm` siblings gives a consistent, lock-free snapshot.
 */
async function querySlackCookieRows(dbPath: string): Promise<ChromeCookieRow[]> {
  const snapshot = join(tmpdir(), `agent-slack-chrome-cookies-${randomUUID()}`);
  const sidecars = ["-wal", "-shm"];
  copyFileSync(dbPath, snapshot);
  for (const suffix of sidecars) {
    if (existsSync(`${dbPath}${suffix}`)) {
      try {
        copyFileSync(`${dbPath}${suffix}`, `${snapshot}${suffix}`);
      } catch {
        // sidecar is best effort
      }
    }
  }

  try {
    return (await queryReadonlySqlite(
      snapshot,
      "select host_key, name, value, encrypted_value from cookies where name = 'd' and host_key like '%slack.com' order by length(encrypted_value) desc",
    )) as ChromeCookieRow[];
  } finally {
    for (const path of [snapshot, ...sidecars.map((suffix) => `${snapshot}${suffix}`)]) {
      try {
        unlinkSync(path);
      } catch {
        // ignore
      }
    }
  }
}

async function extractCookieDFromChrome(): Promise<string> {
  const dbPaths = getChromeCookieDbPaths(CHROME_USER_DATA_DIR);
  if (dbPaths.length === 0) {
    throw new Error(`Chrome Cookies DB not found under ${CHROME_USER_DATA_DIR}`);
  }

  const passwords = getChromeSafeStoragePasswords();
  const errors: string[] = [];

  for (const dbPath of dbPaths) {
    let rows: ChromeCookieRow[];
    try {
      rows = await querySlackCookieRows(dbPath);
    } catch (err: unknown) {
      errors.push(`${dbPath}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    if (!rows || rows.length === 0) {
      errors.push(`${dbPath}: no Slack 'd' cookie`);
      continue;
    }

    for (const row of rows) {
      // App-Bound Encryption is a dead end for every profile, so let it escape.
      const cookie = decryptSlackCookieRow(row, passwords);
      if (cookie) {
        return cookie;
      }
    }
    errors.push(
      passwords.length === 0
        ? `${dbPath}: no Chrome Safe Storage password available from the keychain`
        : `${dbPath}: could not decrypt Slack 'd' cookie`,
    );
  }

  throw new Error(`Could not read the Slack 'd' cookie from Chrome:\n  - ${errors.join("\n  - ")}`);
}

// --- Main export ---

export async function extractFromChrome(): Promise<ChromeExtracted | null> {
  if (!IS_MACOS) {
    return null;
  }

  // Actionable failures propagate; only an unrecognized shape returns null.
  const teams = extractTeamsFromChromeTab();
  if (teams.length === 0) {
    return null;
  }

  const cookie_d = await extractCookieDFromChrome();
  if (!cookie_d || !cookie_d.startsWith("xoxd-")) {
    return null;
  }

  return { cookie_d, teams };
}
