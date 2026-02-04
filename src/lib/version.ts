import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function getPackageVersion(): string {
  const envVersion =
    process.env.AGENT_SLACK_VERSION?.trim() || process.env.npm_package_version?.trim();
  if (envVersion) {
    return envVersion;
  }

  try {
    // When bundled, `import.meta.url` typically points at `dist/index.js`.
    // When running unbundled, it points at `src/lib/version.ts`.
    // Walk upwards until we find the nearest package.json.
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) {
        const raw = readFileSync(candidate, "utf8");
        const pkg = JSON.parse(raw) as { version?: unknown };
        const v = typeof pkg.version === "string" ? pkg.version.trim() : "";
        return v || "0.0.0";
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
  return "0.0.0";
}

export function getUserAgent(): string {
  return `agent-slack/${getPackageVersion()}`;
}
