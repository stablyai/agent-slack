import { createServer, type IncomingMessage, type Server } from "node:http";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export type DraftEditorConfig = {
  channelName: string;
  channelId?: string;
  workspaceUrl?: string;
  threadTs?: string;
  initialText?: string;
  onSend: (mrkdwn: string) => Promise<{ ts: string }>;
};

export type DraftResult = { sent: true; text: string } | { cancelled: true };

export function openDraftEditor(config: DraftEditorConfig): Promise<DraftResult> {
  return new Promise<DraftResult>((resolve, reject) => {
    let settled = false;

    const server: Server = createServer(async (req, res) => {
      if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
        const html = buildEditorHtml(config);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (req.method === "POST" && req.url === "/send") {
        try {
          const body = await readBody(req);
          const data = JSON.parse(body) as { text: string };
          if (typeof data.text !== "string" || !data.text.trim()) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "text is required" }));
            return;
          }
          const sendResult = await config.onSend(data.text);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, ts: sendResult.ts }));
          settled = true;
          resolve({ sent: true, text: data.text });
          setTimeout(() => server.close(), 300);
        } catch (err: unknown) {
          const safeMessage =
            err instanceof Error
              ? err.message.replace(/xox[a-z]-[A-Za-z0-9-]+/g, "[REDACTED]")
              : "Send failed";
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: safeMessage }));
        }
        return;
      }

      if (req.method === "POST" && req.url === "/cancel") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        settled = true;
        resolve({ cancelled: true });
        setTimeout(() => server.close(), 300);
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    server.on("error", (err) => {
      if (!settled) {
        reject(err);
      }
    });

    server.on("close", () => {
      clearTimeout(idleTimeout);
      if (!settled) {
        settled = true;
        resolve({ cancelled: true });
      }
    });

    const idleTimeout = setTimeout(
      () => {
        if (!settled) {
          server.close();
        }
      },
      30 * 60 * 1000,
    );

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const url = `http://127.0.0.1:${port}`;
      process.stderr.write(`Draft editor: ${url}\n`);
      openBrowser(url);
    });
  });
}

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  execFile(cmd, [url], () => {});
}

function buildSlackThreadUrl(config: DraftEditorConfig): string | null {
  if (!config.workspaceUrl || !config.channelId || !config.threadTs) {
    return null;
  }
  const tsNoDot = config.threadTs.replaceAll(".", "");
  return `${config.workspaceUrl.replace(/\/$/, "")}/archives/${config.channelId}/p${tsNoDot}`;
}

function extractWorkspaceName(url?: string): string | null {
  if (!url) {
    return null;
  }
  try {
    const host = new URL(url).hostname; // e.g. "stablygroup.slack.com"
    const parts = host.split(".");
    if (parts.length >= 3 && parts.at(-2) === "slack") {
      return parts.slice(0, -2).join("."); // e.g. "stablygroup"
    }
    return host;
  } catch {
    return null;
  }
}

function buildEditorHtml(config: DraftEditorConfig): string {
  const threadUrl = buildSlackThreadUrl(config);
  const workspaceName = extractWorkspaceName(config.workspaceUrl);
  const injectedConfig = JSON.stringify({
    channelName: config.channelName,
    channelId: config.channelId || null,
    workspaceUrl: config.workspaceUrl || null,
    workspaceName,
    threadTs: config.threadTs || null,
    threadUrl,
    initialText: config.initialText || "",
  });

  // JSON.stringify handles quotes/backslashes; escape < and > to prevent
  // </script> breakout and other HTML injection in <script> context.
  const safeConfig = injectedConfig.replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  return getEditorHtml().replace("__DRAFT_CONFIG__", safeConfig);
}

// ---------------------------------------------------------------------------
// Self-contained HTML editor — lazy-loaded from draft-editor.html
// ---------------------------------------------------------------------------

let _editorHtml: string | undefined;

function getEditorHtml(): string {
  if (!_editorHtml) {
    _editorHtml = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "draft-editor.html"),
      "utf-8",
    );
  }
  return _editorHtml;
}
