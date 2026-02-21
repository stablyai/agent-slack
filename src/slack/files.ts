import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { SlackAuth } from "./client.ts";
import { existsSync } from "node:fs";
import { getUserAgent } from "../lib/version.ts";

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

  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    throw new Error(`Failed to download file (${resp.status})`);
  }
  const contentType = resp.headers.get("content-type") || "";
  if (!options?.allowHtml && contentType.includes("text/html")) {
    const text = await resp.text();
    throw new Error(
      `Downloaded HTML instead of file (auth likely failed). First bytes: ${JSON.stringify(
        text.slice(0, 120),
      )}`,
    );
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  await writeFile(path, buf);
  return path;
}

export function looksLikeAuthPage(html: string): boolean {
  return /<form[^>]+signin|data-qa="signin|<title>[^<]*Sign\s*in|"shouldRedirect"\s*:\s*true|"redirectURL"\s*:\s*"[^"]*files-pri/i.test(
    html,
  );
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/<>:"|?*]/g, "_");
}
