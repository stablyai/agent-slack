import { platform } from "node:os";
import { execFileSync } from "node:child_process";

const IS_MACOS = platform() === "darwin";
const DEFAULT_KEYCHAIN_TIMEOUT_MS = 3_000;

export function getKeychainTimeoutMs(): number {
  const raw = process.env.AGENT_SLACK_KEYCHAIN_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_KEYCHAIN_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_KEYCHAIN_TIMEOUT_MS;
  }
  return Math.floor(parsed);
}

export function keychainGet(account: string, service: string): string | null {
  if (!IS_MACOS) {
    return null;
  }
  try {
    const result = execFileSync(
      "security",
      ["find-generic-password", "-s", service, "-a", account, "-w"],
      {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
        timeout: getKeychainTimeoutMs(),
      },
    );
    return result.trim() || null;
  } catch {
    return null;
  }
}

export function keychainSet(input: { account: string; value: string; service: string }): boolean {
  if (!IS_MACOS) {
    return false;
  }
  const { account, value, service } = input;
  try {
    try {
      execFileSync("security", ["delete-generic-password", "-s", service, "-a", account], {
        stdio: ["pipe", "pipe", "ignore"],
        timeout: getKeychainTimeoutMs(),
      });
    } catch {
      // ignore
    }
    execFileSync("security", ["add-generic-password", "-s", service, "-a", account, "-w", value], {
      stdio: "pipe",
      timeout: getKeychainTimeoutMs(),
    });
    return true;
  } catch {
    return false;
  }
}
