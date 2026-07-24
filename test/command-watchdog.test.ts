import { describe, expect, test } from "bun:test";
import { shouldStartCommandWatchdog } from "../src/cli/command-watchdog.ts";

describe("shouldStartCommandWatchdog", () => {
  test("never caps complete user resolution regardless of global option order", () => {
    expect(shouldStartCommandWatchdog(["user", "resolve", "@alice"])).toBe(false);
    expect(shouldStartCommandWatchdog(["--safe-mode", "user", "resolve", "@alice"])).toBe(false);
    expect(shouldStartCommandWatchdog(["user", "--safe-mode", "resolve", "@alice"])).toBe(false);
  });

  test("preserves existing watchdog behavior for other command paths", () => {
    expect(shouldStartCommandWatchdog(["message", "draft", "list"])).toBe(false);
    expect(shouldStartCommandWatchdog(["update"])).toBe(false);
    expect(shouldStartCommandWatchdog(["user", "get", "@alice"])).toBe(true);
    expect(shouldStartCommandWatchdog(["--safe-mode", "message", "draft", "list"])).toBe(true);
    expect(shouldStartCommandWatchdog(["--safe-mode", "update"])).toBe(true);
  });
});
