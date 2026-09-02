import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Injected at build time via --define AGENT_SLACK_BUILD_VERSION='"x.y.z"'
declare const AGENT_SLACK_BUILD_VERSION: string | undefined;

let cachedVersion: string | undefined;

export function getPackageVersion(): string {
  if (cachedVersion !== undefined) {
    return cachedVersion;
  }

  // 1. Check build-time injected version (for compiled binaries)
  if (typeof AGENT_SLACK_BUILD_VERSION === "string" && AGENT_SLACK_BUILD_VERSION) {
    cachedVersion = AGENT_SLACK_BUILD_VERSION;
    return cachedVersion;
  }

  // 2. Check environment variables
  const envVersion =
    process.env.AGENT_SLACK_VERSION?.trim() || process.env.npm_package_version?.trim();
  if (envVersion) {
    cachedVersion = envVersion;
    return cachedVersion;
  }

  // 3. Try to read from package.json (for development)
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) {
        const raw = readFileSync(candidate, "utf8");
        const pkg = JSON.parse(raw) as { version?: unknown };
        const v = typeof pkg.version === "string" ? pkg.version.trim() : "";
        cachedVersion = v || "0.0.0";
        return cachedVersion;
      }
      const next = dirname(dir);
      if (next === dir) {
        break;
      }
      dir = next;
    }
  } catch {
    // fall through
  }

  cachedVersion = "0.0.0";
  return cachedVersion;
}

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

// Used only for Slack browser-session (xoxc/xoxd) API calls in slack/client.ts,
// slack/files.ts, and slack/canvas.ts. Those requests replay a real browser's
// session cookie, so the UA must look like a browser too, or Slack's
// enterprise session-security policy flags the mismatch as a fingerprint
// anomaly (`unexpected_user_agent`) and kills the session, logging the real
// browser out. Defaults to a static Chrome/macOS UA; bump DEFAULT_USER_AGENT
// periodically to a current Chrome release (Slack's check appears to be
// "is this browser-shaped", not an exact version match).
//
// Override via the AGENT_SLACK_USER_AGENT env var, or the global
// `--user-agent <string>` CLI flag (index.ts copies the flag into the env
// var via a commander preAction hook before any command runs).
export function getUserAgent(): string {
  return process.env.AGENT_SLACK_USER_AGENT?.trim() || DEFAULT_USER_AGENT;
}
