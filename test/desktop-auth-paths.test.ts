import { describe, expect, test } from "bun:test";
import { isWindowsStoreSlackPackageName } from "../src/auth/desktop.ts";

describe("Windows Store Slack package detection", () => {
  test("matches known Microsoft Store package identifiers", () => {
    expect(isWindowsStoreSlackPackageName("com.tinyspeck.slackdesktop_8wekyb3d8bbwe")).toBe(true);
    expect(isWindowsStoreSlackPackageName("91750D7E.Slack_8she8kybcnzg4")).toBe(true);
  });

  test("does not match unrelated packages", () => {
    expect(isWindowsStoreSlackPackageName("com.example.SlackNotes_123")).toBe(false);
    expect(isWindowsStoreSlackPackageName("91750D7E.SlackBackup_123")).toBe(false);
  });
});
