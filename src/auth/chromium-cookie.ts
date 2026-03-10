import { pbkdf2Sync, createDecipheriv } from "node:crypto";

export function decryptChromiumCookieValue(
  data: Buffer,
  options: { password: string; iterations: number },
): string {
  if (!data || data.length === 0) {
    return "";
  }

  const { password, iterations } = options;

  if (iterations < 1) {
    throw new RangeError(`iterations must be >= 1, got ${iterations}`);
  }

  const salt = Buffer.from("saltysalt", "utf8");
  const iv = Buffer.alloc(16, " ");
  const key = pbkdf2Sync(password, salt, iterations, 16, "sha1");

  const decipher = createDecipheriv("aes-128-cbc", key, iv);
  decipher.setAutoPadding(true);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  const marker = Buffer.from("xoxd-");
  const idx = plain.indexOf(marker);
  if (idx === -1) {
    return plain.toString("utf8");
  }

  let end = idx;
  while (end < plain.length) {
    const b = plain[end]!;
    if (b < 0x21 || b > 0x7e) {
      break;
    }
    end++;
  }
  const rawToken = plain.subarray(idx, end).toString("utf8");
  try {
    return decodeURIComponent(rawToken);
  } catch {
    return rawToken;
  }
}
