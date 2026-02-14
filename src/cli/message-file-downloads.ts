import type { SlackAuth } from "../slack/client.ts";
import type { SlackMessageSummary } from "../slack/messages.ts";
import { ensureDownloadsDir } from "../lib/tmp-paths.ts";
import { downloadSlackFile } from "../slack/files.ts";
import { htmlToMarkdown } from "../slack/html-to-md.ts";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

function inferFileExtension(file: {
  mimetype?: string;
  filetype?: string;
  name?: string;
  title?: string;
}): string | null {
  const mt = (file.mimetype || "").toLowerCase();
  const ft = (file.filetype || "").toLowerCase();

  if (mt === "image/png" || ft === "png") {
    return "png";
  }
  if (mt === "image/jpeg" || mt === "image/jpg" || ft === "jpg" || ft === "jpeg") {
    return "jpg";
  }
  if (mt === "image/webp" || ft === "webp") {
    return "webp";
  }
  if (mt === "image/gif" || ft === "gif") {
    return "gif";
  }

  if (mt === "text/plain" || ft === "text") {
    return "txt";
  }
  if (mt === "text/markdown" || ft === "markdown" || ft === "md") {
    return "md";
  }
  if (mt === "application/json" || ft === "json") {
    return "json";
  }

  const name = file.name || file.title || "";
  const match = name.match(/\.([A-Za-z0-9]{1,10})$/);
  return match ? match[1]!.toLowerCase() : null;
}

const CANVAS_MODES = new Set(["canvas", "quip", "docs"]);

function looksLikeAuthPage(html: string): boolean {
  return /<form[^>]+signin|data-qa="signin|<title>[^<]*Sign\s*in/i.test(html);
}

async function downloadCanvasAsMarkdown(input: {
  auth: SlackAuth;
  fileId: string;
  url: string;
  destDir: string;
}): Promise<string> {
  const htmlPath = await downloadSlackFile({
    auth: input.auth,
    url: input.url,
    destDir: input.destDir,
    preferredName: `${input.fileId}.html`,
    options: { allowHtml: true },
  });
  const html = await readFile(htmlPath, "utf8");
  if (looksLikeAuthPage(html)) {
    throw new Error("Downloaded auth/login page instead of canvas content (token may be expired)");
  }

  const markdown = htmlToMarkdown(html).trim();
  const safeName = `${input.fileId.replace(/[\\/<>"|?*]/g, "_")}.md`;
  const markdownPath = join(input.destDir, safeName);
  await writeFile(markdownPath, markdown, "utf8");
  return markdownPath;
}

export async function downloadMessageFiles(input: {
  auth: SlackAuth;
  messages: SlackMessageSummary[];
}): Promise<Record<string, string>> {
  const downloadedPaths: Record<string, string> = {};
  const downloadsDir = await ensureDownloadsDir();

  for (const message of input.messages) {
    for (const file of message.files ?? []) {
      if (downloadedPaths[file.id]) {
        continue;
      }

      const isCanvas = file.mode != null && CANVAS_MODES.has(file.mode);
      const url = isCanvas
        ? file.url_private || file.url_private_download
        : file.url_private_download || file.url_private;
      if (!url) {
        continue;
      }

      try {
        if (isCanvas) {
          downloadedPaths[file.id] = await downloadCanvasAsMarkdown({
            auth: input.auth,
            fileId: file.id,
            url,
            destDir: downloadsDir,
          });
        } else {
          const ext = inferFileExtension(file);
          downloadedPaths[file.id] = await downloadSlackFile({
            auth: input.auth,
            url,
            destDir: downloadsDir,
            preferredName: `${file.id}${ext ? `.${ext}` : ""}`,
          });
        }
      } catch (err) {
        console.error(
          `Warning: skipping file ${file.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  return downloadedPaths;
}
