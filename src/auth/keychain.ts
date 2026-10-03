import { platform } from "node:os";
import { execFileSync } from "node:child_process";

const IS_MACOS = platform() === "darwin";
const DEFAULT_KEYCHAIN_TIMEOUT_MS = 3_000;
// Explicit `auth import-*` commands can trigger a macOS keychain prompt
// ("security wants to use your confidential information..."). The user needs
// time to type their login password, so don't kill `security` after 3s.
const INTERACTIVE_KEYCHAIN_TIMEOUT_MS = 120_000;
// `security` exits with errSecItemNotFound (-25300) truncated to a byte.
const SECURITY_EXIT_ITEM_NOT_FOUND = 44;

export type KeychainOptions = {
  // True when the user explicitly asked for the import and can answer a
  // keychain prompt; false for implicit lookups (e.g. auth auto-refresh).
  interactive?: boolean;
};

export type KeychainQuery = { service: string; account?: string };

export type KeychainReadResult =
  | { ok: true; value: string }
  | { ok: false; notFound: true }
  | { ok: false; notFound: false; message: string };

// A keychain item exists but could not be read: the prompt timed out or the
// user denied it. Unlike "item not found", the user needs to act on this.
export class KeychainAccessError extends Error {
  override name = "KeychainAccessError";
}

export function getKeychainTimeoutMs(options: KeychainOptions = {}): number {
  const fallback = options.interactive
    ? INTERACTIVE_KEYCHAIN_TIMEOUT_MS
    : DEFAULT_KEYCHAIN_TIMEOUT_MS;
  const raw = process.env.AGENT_SLACK_KEYCHAIN_TIMEOUT_MS?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function describeKeychainQuery(query: KeychainQuery): string {
  return query.account ? `"${query.service}" (account "${query.account}")` : `"${query.service}"`;
}

export function classifyKeychainError(
  err: unknown,
  { query, timeoutMs }: { query: KeychainQuery; timeoutMs: number },
): KeychainReadResult {
  const e = (err ?? {}) as {
    code?: unknown;
    status?: unknown;
    stderr?: unknown;
    message?: unknown;
  };
  const item = describeKeychainQuery(query);
  if (e.code === "ETIMEDOUT") {
    return {
      ok: false,
      notFound: false,
      message:
        `Timed out after ${timeoutMs}ms waiting for macOS keychain access to ${item}. ` +
        `If a keychain password prompt appeared, re-run the command and answer it ` +
        `(choose "Always Allow" to avoid future prompts), or set AGENT_SLACK_KEYCHAIN_TIMEOUT_MS to wait longer.`,
    };
  }
  if (e.status === SECURITY_EXIT_ITEM_NOT_FOUND) {
    return { ok: false, notFound: true };
  }
  const detail = String(e.stderr ?? "").trim() || String(e.message ?? err);
  return {
    ok: false,
    notFound: false,
    message:
      `macOS keychain access to ${item} failed: ${detail}. ` +
      `If you denied a keychain prompt, re-run the command and choose "Allow" or "Always Allow".`,
  };
}

export function readMacKeychainPassword(
  query: KeychainQuery,
  options: KeychainOptions = {},
): KeychainReadResult {
  const timeoutMs = getKeychainTimeoutMs(options);
  const args = ["find-generic-password", "-w", "-s", query.service];
  if (query.account) {
    args.push("-a", query.account);
  }
  try {
    const value = execFileSync("security", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    }).trim();
    return value ? { ok: true, value } : { ok: false, notFound: true };
  } catch (err: unknown) {
    return classifyKeychainError(err, { query, timeoutMs });
  }
}

/**
 * Lazily yield the distinct passwords found for `queries`, in order, so that
 * callers can stop at the first one that works without triggering further
 * keychain prompts. Missing items are skipped. A timeout or denial stops the
 * lookup and throws: the user didn't (or wouldn't) answer the prompt, so more
 * prompts would only add noise.
 */
export function* macKeychainPasswords(
  queries: KeychainQuery[],
  options: KeychainOptions & {
    // Injectable for tests.
    read?: (query: KeychainQuery, options: KeychainOptions) => KeychainReadResult;
  } = {},
): Generator<string, void, undefined> {
  const { read = readMacKeychainPassword } = options;
  const seen = new Set<string>();
  for (const query of queries) {
    const result = read(query, options);
    if (result.ok) {
      if (!seen.has(result.value)) {
        seen.add(result.value);
        yield result.value;
      }
      continue;
    }
    if (!result.notFound) {
      throw new KeychainAccessError(result.message);
    }
  }
  if (seen.size === 0) {
    throw new Error(
      `No matching item found in the macOS keychain (looked for ${queries.map(describeKeychainQuery).join(", ")}).`,
    );
  }
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
