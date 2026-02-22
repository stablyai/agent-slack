import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { getAppDir } from "./app-dir.ts";
import { readJsonFile, writeJsonFile } from "./fs.ts";
import { getPackageVersion } from "./version.ts";

const REPO = "stablyai/agent-slack";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

type UpdateCheckCache = {
  latest_version: string;
  checked_at: number; // epoch ms
};

type GitHubRelease = {
  tag_name: string;
  assets: { name: string; browser_download_url: string }[];
};

function getCachePath(): string {
  return join(getAppDir(), "update-check.json");
}

/**
 * Compare two semver strings. Returns:
 *   negative if a < b, 0 if equal, positive if a > b
 */
export function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/**
 * Fetch the latest release version from GitHub.
 * Returns null on any network/API error (never throws).
 */
export async function fetchLatestVersion(): Promise<string | null> {
  try {
    const resp = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "agent-slack-updater" },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) {
      return null;
    }
    const data = (await resp.json()) as GitHubRelease;
    return data.tag_name?.replace(/^v/, "") ?? null;
  } catch {
    return null;
  }
}

/**
 * Check if a newer version is available. Uses a local cache to avoid
 * hitting GitHub more than once per CHECK_INTERVAL_MS.
 *
 * @param force  Skip the cache and always fetch from GitHub.
 * @returns `{ current, latest, updateAvailable }` or null on error.
 */
export async function checkForUpdate(force = false): Promise<{
  current: string;
  latest: string;
  update_available: boolean;
} | null> {
  const current = getPackageVersion();

  if (!force) {
    const cached = await readJsonFile<UpdateCheckCache>(getCachePath());
    if (cached && Date.now() - cached.checked_at < CHECK_INTERVAL_MS) {
      return {
        current,
        latest: cached.latest_version,
        update_available: compareSemver(cached.latest_version, current) > 0,
      };
    }
  }

  const latest = await fetchLatestVersion();
  if (!latest) {
    return null;
  }

  // Persist cache (best-effort, never throw)
  try {
    await writeJsonFile(getCachePath(), {
      latest_version: latest,
      checked_at: Date.now(),
    } satisfies UpdateCheckCache);
  } catch {
    // ignore
  }

  return {
    current,
    latest,
    update_available: compareSemver(latest, current) > 0,
  };
}

export type InstallMethod = "binary" | "npm" | "bun";

/**
 * Detect how agent-slack was installed so we can use the right update strategy.
 *
 * - "npm"    → running via Node.js (npm install -g agent-slack)
 * - "bun"    → running via Bun runtime (bun install -g agent-slack / bunx)
 * - "binary" → standalone compiled binary (GitHub release)
 */
export function detectInstallMethod(): InstallMethod {
  // Running under Bun runtime (bun install -g, bunx, bun run, etc.)
  // Note: compiled bun binaries also have process.versions.bun set,
  // so we check that the executable is actually the bun runtime itself.
  if (process.versions.bun && basename(process.execPath) === "bun") {
    return "bun";
  }

  // Running under Node.js (npm install -g, npx, etc.)
  const execName = basename(process.execPath);
  if (["node", "nodejs", "node.exe"].includes(execName) || process.env.npm_execpath) {
    return "npm";
  }

  // Standalone compiled binary
  return "binary";
}

/**
 * Return the shell command a user should run to update, based on install method.
 */
export function getUpdateCommand(method?: InstallMethod): string {
  const m = method ?? detectInstallMethod();
  switch (m) {
    case "npm":
      return "npm install -g agent-slack@latest";
    case "bun":
      return "bun install -g agent-slack@latest";
    case "binary":
      return "agent-slack update";
  }
}

/**
 * Update via a package manager (npm or bun).
 * Spawns the package manager synchronously and returns the result.
 */
export function performPackageManagerUpdate(method: "npm" | "bun"): {
  success: boolean;
  message: string;
} {
  const cmd = getUpdateCommand(method);
  try {
    execSync(cmd, { stdio: ["inherit", "pipe", "inherit"] });
    return { success: true, message: `Updated agent-slack via: ${cmd}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Failed to run "${cmd}": ${msg}` };
  }
}

function detectPlatformAsset(): string {
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const archMap: Record<string, string> = { x64: "x64", arm64: "arm64" };
  const arch = archMap[process.arch] ?? process.arch;
  const ext = platform === "windows" ? ".exe" : "";
  return `agent-slack-${platform}-${arch}${ext}`;
}

async function sha256(filePath: string): Promise<string> {
  const data = await readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Download, verify, and replace the current binary with the latest release.
 * Returns `true` on success.
 */
export async function performUpdate(
  latest: string,
): Promise<{ success: boolean; message: string }> {
  const asset = detectPlatformAsset();
  const tag = `v${latest}`;
  const baseUrl = `https://github.com/${REPO}/releases/download/${tag}`;

  const tmp = join(tmpdir(), `agent-slack-update-${Date.now()}`);
  await mkdir(tmp, { recursive: true });

  const binTmp = join(tmp, asset);
  const sumsTmp = join(tmp, "checksums-sha256.txt");

  try {
    // Download binary + checksums in parallel
    const [binResp, sumsResp] = await Promise.all([
      fetch(`${baseUrl}/${asset}`, { signal: AbortSignal.timeout(120_000) }),
      fetch(`${baseUrl}/checksums-sha256.txt`, { signal: AbortSignal.timeout(30_000) }),
    ]);

    if (!binResp.ok) {
      return { success: false, message: `Failed to download ${asset}: HTTP ${binResp.status}` };
    }
    if (!sumsResp.ok) {
      return { success: false, message: `Failed to download checksums: HTTP ${sumsResp.status}` };
    }

    await writeFile(binTmp, Buffer.from(await binResp.arrayBuffer()));
    const sumsText = await sumsResp.text();
    await writeFile(sumsTmp, sumsText);

    // Verify checksum
    const expected = sumsText
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .find((parts) => parts[1] === asset)?.[0];

    if (!expected) {
      return { success: false, message: `Checksum not found for ${asset} in release checksums` };
    }

    const actual = await sha256(binTmp);
    if (actual !== expected) {
      return { success: false, message: `Checksum mismatch: expected ${expected}, got ${actual}` };
    }

    // Replace current binary
    const currentBin = process.execPath;
    const backupPath = `${currentBin}.bak`;

    // Rename current -> backup, copy new -> current, remove backup
    await rename(currentBin, backupPath);
    try {
      await copyFile(binTmp, currentBin);
      await chmod(currentBin, 0o755);
      await rm(backupPath, { force: true });
    } catch (err) {
      // Restore backup on failure
      try {
        await rename(backupPath, currentBin);
      } catch {
        // ignore restore failure
      }
      throw err;
    }

    return { success: true, message: `Updated agent-slack to ${latest}` };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Background update check. Writes a notice to stderr if an update is available.
 * Swallows all errors silently. Respects the 24-hour throttle.
 * Disable with AGENT_SLACK_NO_UPDATE_CHECK=1.
 */
export async function backgroundUpdateCheck(): Promise<void> {
  if (process.env.AGENT_SLACK_NO_UPDATE_CHECK === "1") {
    return;
  }
  try {
    const result = await checkForUpdate();
    if (result?.update_available) {
      const cmd = getUpdateCommand();
      process.stderr.write(
        `\nUpdate available: ${result.current} → ${result.latest}. Run "${cmd}" to upgrade.\n`,
      );
    }
  } catch {
    // never interfere with normal operation
  }
}
