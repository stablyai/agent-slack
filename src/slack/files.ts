import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { SlackAuth } from "./client.ts";
import { existsSync } from "node:fs";
import { getUserAgent } from "../lib/version.ts";

export class SlackDownloadError extends Error {
  constructor(
    message: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "SlackDownloadError";
  }
}

export type DownloadResult =
  | { ok: true; path: string }
  | { ok: false; error: string; httpStatus?: number; path?: string };

export async function downloadSlackFile(input: {
  auth: SlackAuth;
  url: string;
  destDir: string;
  preferredName?: string;
  options?: { allowHtml?: boolean };
}): Promise<string> {
  const { auth, url, destDir, preferredName, options } = input;
  const absDir = resolve(destDir);
  await mkdir(absDir, { recursive: true });
  const name = sanitizeFilename(preferredName || basename(new URL(url).pathname) || "file");
  const path = join(absDir, name);

  if (existsSync(path)) {
    return path;
  }

  const headers: Record<string, string> = {};
  if (auth.auth_type === "standard") {
    headers.Authorization = `Bearer ${auth.token}`;
  } else {
    headers.Authorization = `Bearer ${auth.xoxc_token}`;
    headers.Cookie = `d=${encodeURIComponent(auth.xoxd_cookie)}`;
    headers.Referer = "https://app.slack.com/";
    headers["User-Agent"] = getUserAgent();
  }

  let resp: Response;
  try {
    resp = await fetch(url, { headers });
  } catch (err) {
    throw new SlackDownloadError(
      `Network error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!resp.ok) {
    throw new SlackDownloadError(`Failed to download file (${resp.status})`, resp.status);
  }
  const contentType = resp.headers.get("content-type") || "";
  if (!options?.allowHtml && contentType.includes("text/html")) {
    let text: string;
    try {
      text = await resp.text();
    } catch (err) {
      throw new SlackDownloadError(
        `Failed to read download response body: ${err instanceof Error ? err.message : String(err)}`,
        resp.status,
      );
    }
    throw new SlackDownloadError(
      `Downloaded HTML instead of file (auth likely failed). First bytes: ${JSON.stringify(
        text.slice(0, 120),
      )}`,
      resp.status,
    );
  }
  let arrayBuffer: ArrayBuffer;
  try {
    arrayBuffer = await resp.arrayBuffer();
  } catch (err) {
    throw new SlackDownloadError(
      `Failed to read download response body: ${err instanceof Error ? err.message : String(err)}`,
      resp.status,
    );
  }
  const buf = Buffer.from(arrayBuffer);
  await writeFile(path, buf);
  return path;
}

export async function tryDownloadSlackFile(
  input: Parameters<typeof downloadSlackFile>[0],
): Promise<DownloadResult> {
  try {
    const path = await downloadSlackFile(input);
    return { ok: true, path };
  } catch (err) {
    if (err instanceof SlackDownloadError) {
      return { ok: false, error: err.message, httpStatus: err.httpStatus };
    }
    throw err;
  }
}

export async function writeDownloadErrorFile(input: {
  destDir: string;
  fileId: string;
  error: string;
}): Promise<string> {
  const absDir = resolve(input.destDir);
  await mkdir(absDir, { recursive: true });
  const path = join(absDir, sanitizeFilename(`${input.fileId}.download-error.txt`));
  await writeFile(path, `${input.error}\n`, "utf8");
  return path;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/<>:"|?*]/g, "_");
}
