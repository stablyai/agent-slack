import type { SlackApiClient, SlackAuth } from "./client.ts";
import { downloadSlackFile } from "./files.ts";
import { htmlToMarkdown } from "./html-to-md.ts";
import { ensureDownloadsDir } from "../lib/tmp-paths.ts";
import { readFile } from "node:fs/promises";

export type SlackCanvasRef = {
  workspace_url: string;
  canvas_id: string; // looks like a file id, e.g. F080JDE025R
  raw: string;
};

export function parseSlackCanvasUrl(input: string): SlackCanvasRef {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Invalid URL: ${input}`);
  }

  if (!/\.slack\.com$/i.test(url.hostname)) {
    throw new Error(`Not a Slack workspace URL: ${url.hostname}`);
  }

  // Common form: /docs/<team_id>/<canvas_id>
  // Example seen in Slack docs: https://workspace.slack.com/docs/T.../F...
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "docs") {
    throw new Error(`Unsupported Slack canvas URL path: ${url.pathname}`);
  }

  const canvas_id = parts.find((p) => /^F[A-Z0-9]{8,}$/.test(p));
  if (!canvas_id) throw new Error(`Could not find canvas id in: ${url.pathname}`);

  const workspace_url = `${url.protocol}//${url.host}`;
  return { workspace_url, canvas_id, raw: input };
}

export async function fetchCanvasMarkdown(
  client: SlackApiClient,
  auth: SlackAuth,
  workspaceUrl: string,
  canvasId: string,
  options?: { maxChars?: number; downloadHtml?: boolean },
): Promise<{ canvas: { id: string; title?: string; markdown: string } }> {
  const info = await client.api("files.info", { file: canvasId });
  const file = info.file as any;
  if (!file) throw new Error("Canvas not found (files.info returned no file)");

  const title = (file.title || file.name || "").trim() || undefined;
  const downloadUrl: string | undefined =
    file.url_private_download || file.url_private;
  if (!downloadUrl) throw new Error("Canvas has no download URL");

  let html = "";
  if (options?.downloadHtml ?? true) {
    const htmlPath = await downloadSlackFile(
      auth,
      downloadUrl,
      // keep canvases with other downloads (agent-friendly temp dir)
      // filename uses canvasId (unique)
      // Note: canvases download as HTML via Slack file endpoints
      // so allowHtml must be true.
      await ensureDownloadsDir(),
      `${canvasId}.html`,
      { allowHtml: true },
    );
    html = await readFile(htmlPath, "utf8");
  } else {
    const headers: Record<string, string> = {};
    if (auth.auth_type === "standard") {
      headers.Authorization = `Bearer ${auth.token}`;
    } else {
      headers.Authorization = `Bearer ${auth.xoxc_token}`;
      headers.Cookie = `d=${encodeURIComponent(auth.xoxd_cookie)}`;
      headers.Referer = "https://app.slack.com/";
      headers["User-Agent"] = "agent-slack/0.1.0";
    }
    const resp = await fetch(downloadUrl, { headers });
    if (!resp.ok)
      throw new Error(`Failed to download canvas HTML (${resp.status})`);
    html = await resp.text();
  }

  const markdownRaw = htmlToMarkdown(html).trim();
  const maxChars = options?.maxChars ?? 20000;
  const markdown =
    maxChars >= 0 && markdownRaw.length > maxChars
      ? markdownRaw.slice(0, maxChars) + "\n…"
      : markdownRaw;

  return {
    canvas: {
      id: canvasId,
      title,
      markdown,
    },
  };
}
