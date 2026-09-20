import { describe, expect, test } from "bun:test";
import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChromeAppBoundEncryptionError,
  ChromeNoSlackTabError,
  decryptSlackCookieRow,
  getChromeCookieDbPaths,
  getChromeProfileDirs,
  parseChromeTeams,
  type ChromeCookieRow,
} from "../src/auth/chrome.ts";

const PASSWORD = "chrome-safe-storage-password";

function encryptChromiumCookie(plaintext: string, prefix: string): Uint8Array {
  const key = pbkdf2Sync(PASSWORD, Buffer.from("saltysalt", "utf8"), 1003, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from(prefix, "utf8"), body]);
}

function makeRow(overrides: Partial<ChromeCookieRow>): ChromeCookieRow {
  return {
    host_key: ".slack.com",
    name: "d",
    value: "",
    encrypted_value: new Uint8Array(),
    ...overrides,
  };
}

describe("parseChromeTeams", () => {
  test("throws an actionable error when no Slack tab is open", () => {
    expect(() => parseChromeTeams("__AGENT_SLACK_NO_TAB__")).toThrow(ChromeNoSlackTabError);
  });

  test("keeps only xoxc entries that carry a workspace URL", () => {
    const raw = JSON.stringify({
      TS7LN8J6M: { url: "https://gpcorporate.slack.com/", name: "GP", token: "xoxc-workspace" },
      E04N67U6VNC: { url: "https://gp.enterprise.slack.com/", token: "xoxc-enterprise" },
      bogus: { url: "https://other.slack.com/", token: "xoxb-not-a-client-token" },
      noUrl: { token: "xoxc-orphan" },
    });

    expect(parseChromeTeams(raw)).toEqual([
      { url: "https://gpcorporate.slack.com/", name: "GP", token: "xoxc-workspace" },
      { url: "https://gp.enterprise.slack.com/", name: undefined, token: "xoxc-enterprise" },
    ]);
  });

  test("returns no teams for unusable payloads", () => {
    expect(parseChromeTeams("{}")).toEqual([]);
    expect(parseChromeTeams("not json")).toEqual([]);
  });
});

describe("decryptSlackCookieRow", () => {
  test("prefers an already plaintext value", () => {
    const row = makeRow({ value: "xoxd-plaintext" });
    expect(decryptSlackCookieRow(row, [])).toBe("xoxd-plaintext");
  });

  test("decrypts a v10 Safe Storage value", () => {
    const row = makeRow({ encrypted_value: encryptChromiumCookie("xoxd-secret-token", "v10") });
    expect(decryptSlackCookieRow(row, ["wrong-password", PASSWORD])).toBe("xoxd-secret-token");
  });

  test("percent-decodes the stored cookie", () => {
    const row = makeRow({ encrypted_value: encryptChromiumCookie("xoxd-a%2Fb", "v10") });
    expect(decryptSlackCookieRow(row, [PASSWORD])).toBe("xoxd-a/b");
  });

  test("reports App-Bound Encryption instead of failing silently", () => {
    const row = makeRow({ encrypted_value: encryptChromiumCookie("xoxd-secret-token", "v20") });
    expect(() => decryptSlackCookieRow(row, [PASSWORD])).toThrow(ChromeAppBoundEncryptionError);
  });

  test("returns null when no password opens the value", () => {
    const row = makeRow({ encrypted_value: encryptChromiumCookie("xoxd-secret-token", "v10") });
    expect(decryptSlackCookieRow(row, ["wrong-password"])).toBeNull();
  });

  test("returns null for an empty encrypted value", () => {
    expect(decryptSlackCookieRow(makeRow({}), [PASSWORD])).toBeNull();
  });
});

describe("Chrome profile discovery", () => {
  test("finds Default plus numbered profiles and both cookie locations", () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "agent-slack-chrome-test-"));
    mkdirSync(join(userDataDir, "Default", "Network"), { recursive: true });
    mkdirSync(join(userDataDir, "Profile 1"), { recursive: true });
    mkdirSync(join(userDataDir, "Crashpad"), { recursive: true });
    writeFileSync(join(userDataDir, "Default", "Cookies"), "");
    writeFileSync(join(userDataDir, "Default", "Network", "Cookies"), "");
    writeFileSync(join(userDataDir, "Profile 1", "Cookies"), "");

    expect(getChromeProfileDirs(userDataDir)).toEqual(["Default", "Profile 1"]);
    expect(getChromeCookieDbPaths(userDataDir)).toEqual([
      join(userDataDir, "Default", "Network", "Cookies"),
      join(userDataDir, "Default", "Cookies"),
      join(userDataDir, "Profile 1", "Cookies"),
    ]);
  });

  test("returns nothing for a missing user data dir", () => {
    const missing = join(tmpdir(), "agent-slack-chrome-absent-dir");
    expect(getChromeProfileDirs(missing)).toEqual([]);
    expect(getChromeCookieDbPaths(missing)).toEqual([]);
  });
});
