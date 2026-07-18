import type { SlackApiClient, SlackAuth } from "./client.ts";
import { downloadSlackFile } from "./files.ts";
import { htmlToMarkdown } from "./html-to-md.ts";
import { ensureDownloadsDir } from "../lib/tmp-paths.ts";
import { getString, isRecord } from "../lib/object-type-guards.ts";
import { readFile } from "node:fs/promises";
import { getUserAgent } from "../lib/version.ts";

export type SlackCanvasRef = {
  workspace_url: string;
  canvas_id: string; // looks like a file id, e.g. F080JDE025R
  raw: string;
};

export async function createCanvasFromMarkdown(
  client: SlackApiClient,
  input: {
    auth: SlackAuth;
    markdown: string;
    title?: string;
    channelId?: string;
  },
): Promise<{ canvas: { id: string; title?: string; channel_id?: string } }> {
  if (!input.markdown.trim()) {
    throw new Error("Canvas Markdown is empty");
  }

  const title = input.title?.trim() || undefined;
  let response: Record<string, unknown>;
  let canvasId: string | undefined;

  if (input.auth.auth_type === "browser") {
    if (input.channelId) {
      throw new Error(
        "Adding a canvas as a channel tab requires a standard Slack token; imported browser credentials can create standalone canvases only",
      );
    }
    response = await client.apiMultipart("files.createCanvas", {
      title: title ?? "Untitled",
      markdown: input.markdown,
      loosenValidation: true,
    });
    canvasId = getString(response.file_id);
  } else {
    response = await client.api("canvases.create", {
      title,
      document_content: {
        type: "markdown",
        markdown: input.markdown,
      },
      channel_id: input.channelId,
    });
    canvasId = getString(response.canvas_id);
  }

  if (!canvasId) {
    throw new Error("Slack returned no canvas id");
  }

  return {
    canvas: {
      id: canvasId,
      title: title ?? (input.auth.auth_type === "browser" ? "Untitled" : undefined),
      channel_id: input.channelId,
    },
  };
}

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
  if (!canvas_id) {
    throw new Error(`Could not find canvas id in: ${url.pathname}`);
  }

  const workspace_url = `${url.protocol}//${url.host}`;
  return { workspace_url, canvas_id, raw: input };
}

export async function fetchCanvasMarkdown(
  client: SlackApiClient,
  input: {
    auth: SlackAuth;
    workspaceUrl: string;
    canvasId: string;
    options?: { maxChars?: number; downloadHtml?: boolean };
  },
): Promise<{ canvas: { id: string; title?: string; markdown: string } }> {
  const info = await client.api("files.info", { file: input.canvasId });
  const file = isRecord(info.file) ? info.file : null;
  if (!file) {
    throw new Error("Canvas not found (files.info returned no file)");
  }

  const title = (getString(file.title) || getString(file.name) || "").trim() || undefined;
  const downloadUrl = getString(file.url_private_download) ?? getString(file.url_private);
  if (!downloadUrl) {
    throw new Error("Canvas has no download URL");
  }

  let html = "";
  if (input.options?.downloadHtml ?? true) {
    const htmlPath = await downloadSlackFile({
      auth: input.auth,
      url: downloadUrl,
      // keep canvases with other downloads (agent-friendly temp dir)
      // filename uses canvasId (unique)
      // Note: canvases download as HTML via Slack file endpoints
      // so allowHtml must be true.
      destDir: await ensureDownloadsDir(),
      preferredName: `${input.canvasId}.html`,
      options: { allowHtml: true },
    });
    html = await readFile(htmlPath, "utf8");
  } else {
    const headers: Record<string, string> = {};
    if (input.auth.auth_type === "standard") {
      headers.Authorization = `Bearer ${input.auth.token}`;
    } else {
      headers.Authorization = `Bearer ${input.auth.xoxc_token}`;
      headers.Cookie = `d=${encodeURIComponent(input.auth.xoxd_cookie)}`;
      headers.Referer = "https://app.slack.com/";
      headers["User-Agent"] = getUserAgent();
    }
    const resp = await fetch(downloadUrl, { headers });
    if (!resp.ok) {
      throw new Error(`Failed to download canvas HTML (${resp.status})`);
    }
    html = await resp.text();
  }

  const markdownRaw = htmlToMarkdown(html).trim();
  const maxChars = input.options?.maxChars ?? 20000;
  const markdown =
    maxChars >= 0 && markdownRaw.length > maxChars
      ? `${markdownRaw.slice(0, maxChars)}\n…`
      : markdownRaw;

  return {
    canvas: {
      id: input.canvasId,
      title,
      markdown,
    },
  };
}
