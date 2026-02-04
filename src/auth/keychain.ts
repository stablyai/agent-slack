import { platform } from "node:os";
import { execSync } from "node:child_process";

const IS_MACOS = platform() === "darwin";

export function keychainGet(account: string, service: string): string | null {
  if (!IS_MACOS) {
    return null;
  }
  try {
    const result = execSync(
      `security find-generic-password -s "${service}" -a "${account}" -w 2>/dev/null`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
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
      execSync(`security delete-generic-password -s "${service}" -a "${account}" 2>/dev/null`, {
        stdio: "pipe",
      });
    } catch {
      // ignore
    }
    execSync(`security add-generic-password -s "${service}" -a "${account}" -w "${value}"`, {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}
