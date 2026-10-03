import { afterEach, describe, expect, test } from "bun:test";
import {
  classifyKeychainError,
  getKeychainTimeoutMs,
  KeychainAccessError,
  macKeychainPasswords,
  type KeychainQuery,
  type KeychainReadResult,
} from "../src/auth/keychain.ts";

const SLACK_KEY: KeychainQuery = { service: "Slack Safe Storage", account: "Slack Key" };
const CHROME: KeychainQuery = { service: "Chrome Safe Storage" };

describe("getKeychainTimeoutMs", () => {
  const original = process.env.AGENT_SLACK_KEYCHAIN_TIMEOUT_MS;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.AGENT_SLACK_KEYCHAIN_TIMEOUT_MS;
    } else {
      process.env.AGENT_SLACK_KEYCHAIN_TIMEOUT_MS = original;
    }
  });

  test("fails fast by default but waits for the user on interactive imports", () => {
    delete process.env.AGENT_SLACK_KEYCHAIN_TIMEOUT_MS;
    expect(getKeychainTimeoutMs()).toBe(3_000);
    expect(getKeychainTimeoutMs({ interactive: true })).toBe(120_000);
  });

  test("env var overrides both defaults", () => {
    process.env.AGENT_SLACK_KEYCHAIN_TIMEOUT_MS = "45000";
    expect(getKeychainTimeoutMs()).toBe(45_000);
    expect(getKeychainTimeoutMs({ interactive: true })).toBe(45_000);
  });
});

describe("classifyKeychainError", () => {
  test("timeout explains the keychain prompt and the env var", () => {
    const result = classifyKeychainError(
      { code: "ETIMEDOUT" },
      { query: SLACK_KEY, timeoutMs: 3_000 },
    );
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ notFound: false });
    const { message } = result as { message: string };
    expect(message).toContain("Timed out after 3000ms");
    expect(message).toContain('"Slack Safe Storage" (account "Slack Key")');
    expect(message).toContain("Always Allow");
    expect(message).toContain("AGENT_SLACK_KEYCHAIN_TIMEOUT_MS");
  });

  test("exit status 44 means the item does not exist", () => {
    expect(classifyKeychainError({ status: 44 }, { query: CHROME, timeoutMs: 3_000 })).toEqual({
      ok: false,
      notFound: true,
    });
  });

  test("other failures surface security's stderr", () => {
    const result = classifyKeychainError(
      {
        status: 51,
        stderr: "security: SecKeychainItemCopyContent: User interaction is not allowed.\n",
      },
      { query: SLACK_KEY, timeoutMs: 3_000 },
    );
    expect((result as { message: string }).message).toContain("User interaction is not allowed.");
  });
});

describe("macKeychainPasswords", () => {
  function fakeReader(results: Record<string, KeychainReadResult>) {
    const calls: string[] = [];
    const read = (query: KeychainQuery): KeychainReadResult => {
      const key = query.account ? `${query.service}/${query.account}` : query.service;
      calls.push(key);
      return results[key] ?? { ok: false, notFound: true };
    };
    return { calls, read };
  }

  test("stops querying once the caller has the password it needs", () => {
    const { calls, read } = fakeReader({
      "Slack Safe Storage/Slack Key": { ok: true, value: "slack-pw" },
      "Chrome Safe Storage": { ok: true, value: "chrome-pw" },
    });
    for (const password of macKeychainPasswords([SLACK_KEY, CHROME], { read })) {
      expect(password).toBe("slack-pw");
      break;
    }
    expect(calls).toEqual(["Slack Safe Storage/Slack Key"]);
  });

  test("skips missing items and de-duplicates passwords", () => {
    const { read } = fakeReader({
      "Slack Safe Storage": { ok: true, value: "pw" },
      "Chrome Safe Storage": { ok: true, value: "pw" },
    });
    const queries = [SLACK_KEY, { service: "Slack Safe Storage" }, CHROME];
    expect([...macKeychainPasswords(queries, { read })]).toEqual(["pw"]);
  });

  test("throws KeychainAccessError on timeout without prompting for other items", () => {
    const { calls, read } = fakeReader({
      "Slack Safe Storage/Slack Key": { ok: false, notFound: false, message: "Timed out" },
      "Chrome Safe Storage": { ok: true, value: "chrome-pw" },
    });
    expect(() => [...macKeychainPasswords([SLACK_KEY, CHROME], { read })]).toThrow(
      KeychainAccessError,
    );
    expect(calls).toEqual(["Slack Safe Storage/Slack Key"]);
  });

  test("throws a plain error listing what was looked for when nothing exists", () => {
    const { read } = fakeReader({});
    let caught: unknown;
    try {
      Array.from(macKeychainPasswords([SLACK_KEY, CHROME], { read }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(KeychainAccessError);
    expect(String(caught)).toContain('"Chrome Safe Storage"');
  });
});
