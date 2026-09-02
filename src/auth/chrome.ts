import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { decryptChromiumCookieValue } from "./chromium-cookie.ts";
import { copySqliteForRead, queryReadonlySqlite } from "./firefox-profile.ts";

type ChromeExtractedTeam = { url: string; name?: string; token: string };

export type ChromeExtracted = {
  cookie_d: string;
  teams: ChromeExtractedTeam[];
};

const IS_MACOS = platform() === "darwin";
const CHROME_SUPPORT_DIR = join(homedir(), "Library", "Application Support", "Google", "Chrome");

function escapeOsaScript(script: string): string {
  // osascript -e '...'
  return script.replace(/'/g, `'"'"'`);
}

function osascript(script: string): string {
  return execSync(`osascript -e '${escapeOsaScript(script)}'`, {
    encoding: "utf8",
    timeout: 7000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function cookieScript(): string {
  return `
    tell application "Google Chrome"
      repeat with w in windows
        repeat with t in tabs of w
          if URL of t contains "slack.com" then
            return execute t javascript "document.cookie.split('; ').find(c => c.startsWith('d='))?.split('=')[1] || ''"
          end if
        end repeat
      end repeat
      return ""
    end tell
  `;
}

function getSafeStoragePasswords(): string[] {
  const services = ["Chrome Safe Storage", "Chromium Safe Storage"];
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
  return [...new Set(passwords)];
}

async function chromeCookieDbCandidates(): Promise<string[]> {
  if (!existsSync(CHROME_SUPPORT_DIR)) {
    return [];
  }

  const entries = await readdir(CHROME_SUPPORT_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(CHROME_SUPPORT_DIR, entry.name, "Cookies"))
    .filter((path) => existsSync(path))
    .sort((a, b) => {
      const aName = a.split("/").at(-2) ?? "";
      const bName = b.split("/").at(-2) ?? "";
      if (aName === "Default") {
        return -1;
      }
      if (bName === "Default") {
        return 1;
      }
      return aName.localeCompare(bName);
    });
}

async function extractCookieDFromChromeDb(): Promise<string> {
  const passwords = getSafeStoragePasswords();
  if (passwords.length === 0) {
    return "";
  }

  for (const dbPath of await chromeCookieDbCandidates()) {
    const snapshot = await copySqliteForRead(dbPath);
    try {
      const rows = (await queryReadonlySqlite(
        snapshot.copyPath,
        "select host_key, name, value, encrypted_value from cookies where name = 'd' and host_key like '%slack.com' order by length(encrypted_value) desc",
      )) as {
        host_key: string;
        name: string;
        value: string;
        encrypted_value: Uint8Array;
      }[];

      for (const row of rows) {
        if (row.value && row.value.startsWith("xoxd-")) {
          return row.value;
        }

        const encrypted = Buffer.from(row.encrypted_value || []);
        if (encrypted.length === 0) {
          continue;
        }

        const prefix = encrypted.subarray(0, 3).toString("utf8");
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
      }
    } finally {
      await snapshot.cleanup();
    }
  }

  return "";
}

const TEAM_JSON_PATHS = [
  // Current known storage
  "JSON.stringify(JSON.parse(localStorage.localConfig_v2).teams)",
  "JSON.stringify(JSON.parse(localStorage.localConfig_v3).teams)",
  "JSON.stringify(JSON.parse(localStorage.getItem('reduxPersist:localConfig'))?.teams || {})",
  "JSON.stringify(window.boot_data?.teams || {})",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
      return "{}"
    end tell
  `;
}

export async function extractFromChrome(): Promise<ChromeExtracted | null> {
  if (!IS_MACOS) {
    return null;
  }
  try {
    let cookie = osascript(cookieScript());
    if (!cookie || !cookie.startsWith("xoxd-")) {
      cookie = await extractCookieDFromChromeDb();
    }
    if (!cookie || !cookie.startsWith("xoxd-")) {
      return null;
    }

    const teamsRaw = osascript(teamsScript());
    let teamsObj: unknown = {};
    try {
      teamsObj = JSON.parse(teamsRaw || "{}");
    } catch {
      teamsObj = {};
    }

    const teamsRecord = isRecord(teamsObj) ? teamsObj : {};
    const teams: ChromeExtractedTeam[] = Object.values(teamsRecord)
      .map((t) => toChromeTeam(t))
      .filter((t): t is ChromeExtractedTeam => t !== null);

    if (teams.length === 0) {
      return null;
    }
    return { cookie_d: cookie, teams };
  } catch {
    return null;
  }
}
