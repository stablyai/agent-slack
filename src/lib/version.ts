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

export function getUserAgent(): string {
  return `agent-slack/${getPackageVersion()}`;
}
