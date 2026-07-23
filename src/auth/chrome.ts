import { execSync } from "node:child_process";
import { platform } from "node:os";
import { requireSingleSlackRealm } from "./team-realm.ts";
import type { SlackRealm } from "../slack/workspace-url.ts";

type ChromeExtractedTeam = { url: string; name?: string; token: string };

export type ChromeExtracted = {
  cookie_d: string;
  teams: ChromeExtractedTeam[];
};

const IS_MACOS = platform() === "darwin";

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

function cookieScript(realm: SlackRealm): string {
  const domain = realm === "gov" ? ".slack-gov.com" : ".slack.com";
  return `
    tell application "Google Chrome"
      repeat with w in windows
        repeat with t in tabs of w
          if URL of t contains "${domain}" then
            return execute t javascript "document.cookie.split('; ').find(c => c.startsWith('d='))?.split('=')[1] || ''"
          end if
        end repeat
      end repeat
      return ""
    end tell
  `;
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
          if (URL of t contains ".slack.com") or (URL of t contains ".slack-gov.com") then
            return execute t javascript "(function(){ ${tryPaths.join(" ")} return '{}'; })()"
          end if
        end repeat
      end repeat
      return "{}"
    end tell
  `;
}

export function extractFromChrome(): ChromeExtracted | null {
  if (!IS_MACOS) {
    return null;
  }
  try {
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
    const realm = requireSingleSlackRealm(teams);
    const cookie = osascript(cookieScript(realm));
    if (!cookie || !cookie.startsWith("xoxd-")) {
      return null;
    }
    return { cookie_d: cookie, teams };
  } catch {
    return null;
  }
}
