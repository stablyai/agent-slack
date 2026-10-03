import { describe, expect, test } from "bun:test";
import { shouldStartCommandWatchdog } from "../src/cli/command-watchdog.ts";

describe("shouldStartCommandWatchdog", () => {
  test("guards regular commands", () => {
    expect(shouldStartCommandWatchdog(["message", "send", "#general", "hi"])).toBe(true);
    expect(shouldStartCommandWatchdog(["--safe-mode", "message", "send", "#general", "hi"])).toBe(
      true,
    );
  });

  test("skips commands that wait on the user", () => {
    expect(shouldStartCommandWatchdog([])).toBe(false);
    expect(shouldStartCommandWatchdog(["update"])).toBe(false);
    expect(shouldStartCommandWatchdog(["message", "draft", "#general"])).toBe(false);
    expect(shouldStartCommandWatchdog(["auth", "import-desktop"])).toBe(false);
    expect(shouldStartCommandWatchdog(["auth", "import-brave"])).toBe(false);
  });

  test("ignores global flags before the command", () => {
    expect(shouldStartCommandWatchdog(["--safe-mode", "auth", "import-desktop"])).toBe(false);
    expect(shouldStartCommandWatchdog(["--safe-mode", "auth", "import-brave"])).toBe(false);
    expect(shouldStartCommandWatchdog(["--safe-mode", "message", "draft", "#general"])).toBe(false);
  });
});
