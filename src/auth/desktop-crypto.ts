import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createDecipheriv, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../lib/object-type-guards.ts";

const IS_MACOS = process.platform === "darwin";
const IS_LINUX = process.platform === "linux";

export function getSafeStoragePasswords(prefix: string): string[] {
  if (IS_MACOS) {
    // Electron ("Slack Key") and Mac App Store ("Slack App Store Key") builds
    // store separate Safe Storage passwords under the same service name.
    // Query each known account explicitly, then fall back to service-only
    // lookups to catch unknown account names.
    const keychainQueries: { service: string; account?: string }[] = [
      { service: "Slack Safe Storage", account: "Slack Key" },
      { service: "Slack Safe Storage", account: "Slack App Store Key" },
      { service: "Slack Safe Storage" },
      { service: "Chrome Safe Storage" },
      { service: "Chromium Safe Storage" },
    ];
    const passwords: string[] = [];
    for (const q of keychainQueries) {
      try {
        const args = ["-w", "-s", q.service];
        if (q.account) {
          args.push("-a", q.account);
        }
        const out = execFileSync("security", ["find-generic-password", ...args], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (out) {
          passwords.push(out);
        }
      } catch {
        // continue
      }
    }
    if (passwords.length > 0) {
      return [...new Set(passwords)];
    }
  }

  if (IS_LINUX) {
    const attributes: string[][] = [
      ["application", "com.slack.Slack"],
      ["application", "Slack"],
      ["application", "slack"],
      ["service", "Slack Safe Storage"],
    ];
    const passwords: string[] = [];
    for (const pair of attributes) {
      try {
        const out = execFileSync("secret-tool", ["lookup", ...pair], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (out) {
          passwords.push(out);
        }
      } catch {
        // continue
      }
    }

    // Chromium Linux OSCrypt v10 fallback password (see os_crypt_linux.cc).
    if (prefix === "v11") {
      passwords.push("");
    }
    passwords.push("peanuts");

    return [...new Set(passwords)];
  }

  throw new Error("Could not read Safe Storage password from desktop keychain.");
}

/**
 * Decrypt a Chromium cookie on Windows using DPAPI + AES-256-GCM.
 *
 * On Windows (Chromium v80+), cookies are encrypted as:
 *   v10/v11 + 12-byte nonce + AES-256-GCM ciphertext + 16-byte auth tag
 *
 * The AES key is stored DPAPI-encrypted in the "Local State" file under
 * os_crypt.encrypted_key (base64, prefixed with "DPAPI").
 */
export function decryptCookieWindows(encrypted: Buffer, slackDataDir: string): string {
  // Read the DPAPI-protected AES key from Local State
  const localStatePath = join(slackDataDir, "Local State");
  if (!existsSync(localStatePath)) {
    throw new Error(`Local State file not found: ${localStatePath}`);
  }
  let localState: unknown;
  try {
    localState = JSON.parse(readFileSync(localStatePath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to parse Local State file: ${localStatePath}`, { cause: error });
  }
  const osCrypt = isRecord(localState) ? localState.os_crypt : undefined;
  if (!isRecord(osCrypt) || typeof osCrypt.encrypted_key !== "string") {
    throw new Error("No os_crypt.encrypted_key in Local State");
  }
  const encKeyFull = Buffer.from(osCrypt.encrypted_key as string, "base64");
  // Skip "DPAPI" prefix (5 bytes)
  const encKeyBlob = encKeyFull.subarray(5);

  // Decrypt AES key via Windows DPAPI using PowerShell
  const id = randomUUID();
  const encKeyFile = join(tmpdir(), `as-key-enc-${id}.bin`);
  const decKeyFile = join(tmpdir(), `as-key-dec-${id}.bin`);
  writeFileSync(encKeyFile, encKeyBlob, { mode: 0o600 });
  try {
    // Escape single quotes for PowerShell single-quoted strings (' → '')
    const psEncKeyFile = encKeyFile.replaceAll("'", "''");
    const psDecKeyFile = decKeyFile.replaceAll("'", "''");
    const psCmd = [
      "Add-Type -AssemblyName System.Security",
      `$e=[System.IO.File]::ReadAllBytes('${psEncKeyFile}')`,
      "$d=[System.Security.Cryptography.ProtectedData]::Unprotect($e,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
      `[System.IO.File]::WriteAllBytes('${psDecKeyFile}',$d)`,
    ].join("; ");
    execFileSync("powershell", ["-ExecutionPolicy", "Bypass", "-Command", psCmd], {
      stdio: "pipe",
    });
    if (!existsSync(decKeyFile)) {
      throw new Error("DPAPI decryption failed: PowerShell did not produce the decrypted key file");
    }
    const aesKey = readFileSync(decKeyFile);

    // AES-256-GCM: v10(3) + nonce(12) + ciphertext(N-16) + tag(16)
    const nonce = encrypted.subarray(3, 15);
    const ciphertextWithTag = encrypted.subarray(15);
    const tag = ciphertextWithTag.subarray(-16);
    const ciphertext = ciphertextWithTag.subarray(0, -16);

    const decipher = createDecipheriv("aes-256-gcm", aesKey, nonce);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(ciphertext, undefined, "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  } finally {
    try {
      unlinkSync(encKeyFile);
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(decKeyFile);
    } catch {
      /* ignore */
    }
  }
}
