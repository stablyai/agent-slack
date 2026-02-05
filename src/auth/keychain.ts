import { platform } from "node:os";
import { execFileSync } from "node:child_process";

const IS_MACOS = platform() === "darwin";

export function keychainGet(account: string, service: string): string | null {
  if (!IS_MACOS) {
    return null;
  }
  try {
    const result = execFileSync(
      "security",
      ["find-generic-password", "-s", service, "-a", account, "-w"],
      { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] },
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
      });
    } catch {
      // ignore
    }
    execFileSync("security", ["add-generic-password", "-s", service, "-a", account, "-w", value], {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}
