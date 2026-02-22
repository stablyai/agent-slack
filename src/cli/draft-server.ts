import { createServer, type IncomingMessage, type Server } from "node:http";
import { exec } from "node:child_process";

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
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(err) }));
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  exec(`${cmd} "${url}"`, () => {});
}

function buildSlackThreadUrl(config: DraftEditorConfig): string | null {
  if (!config.workspaceUrl || !config.channelId || !config.threadTs) {
    return null;
  }
  const tsNoDot = config.threadTs.replace(".", "");
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

  return EDITOR_HTML.replace("__DRAFT_CONFIG__", injectedConfig.replace(/</g, "\\u003c"));
}

// ---------------------------------------------------------------------------
// Self-contained HTML editor — Slack-faithful draft composer
// ---------------------------------------------------------------------------
// NOTE: The template below is intentionally large (~900 lines). It is a fully
// self-contained HTML page with CSS + JS — no external dependencies.

const EDITOR_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Draft Message — Agent Slack</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #1a1d21;
    --surface: #222529;
    --surface-raised: #2c2d31;
    --border: #393b3f;
    --border-focus: #1264a3;
    --text: #d1d2d3;
    --text-secondary: #ababad;
    --text-muted: #696a6d;
    --green: #007a5a;
    --green-hover: #148567;
    --red: #e01e5a;
    --blue: #1264a3;
    --blue-link: #1d9bd1;
    --code-bg: #1a1d21;
    --blockquote-border: #616061;
    --toolbar-active: rgba(29,155,209,0.15);
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: Slack-Lato, Lato, appleLogo, sans-serif;
    background: var(--bg);
    color: var(--text);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    min-height: 100vh;
    padding: 40px 24px;
  }

  .page {
    width: 100%;
    max-width: 720px;
    display: flex;
    flex-direction: column;
    align-items: center;
    animation: fadeIn 0.18s ease-out;
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  /* ── Branding ── */
  .brand {
    position: relative;
    text-align: center;
    margin-bottom: 20px;
    user-select: none;
  }
  .brand-name {
    font-size: 17px;
    font-weight: 900;
    letter-spacing: -0.3px;
    color: var(--text);
  }
  .brand-byline {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 2px;
    justify-content: center;
    font-family: 'Inter', sans-serif;
    font-size: 10px;
    font-weight: 500;
    color: rgba(255,255,255,0.5);
  }
  .brand-byline a {
    color: rgba(255,255,255,0.6);
    text-decoration: none;
  }
  .brand-byline a:hover {
    color: rgba(255,255,255,0.8);
  }
  .brand-sub {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: var(--text-muted);
    margin-top: 8px;
  }
  .brand-byline img {
    width: 12px;
    height: 12px;
    opacity: 0.6;
    vertical-align: -1px;
  }

  /* ── Context bar ── */
  .context-bar {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 4px;
    margin-bottom: 10px;
    font-size: 13px;
    color: var(--text-secondary);
  }

  .context-bar .hash-icon {
    width: 15px;
    height: 15px;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .context-bar .channel {
    font-weight: 700;
    color: var(--text);
  }

  .context-bar .workspace-label {
    color: var(--text-muted);
    font-size: 13px;
    margin-left: 8px;
  }

  .context-bar .thread-link {
    margin-left: auto;
    font-size: 12px;
    color: var(--blue-link);
    text-decoration: none;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .context-bar .thread-link:hover { text-decoration: underline; }
  .context-bar .thread-link svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
  }

  /* ── Composer card ── */
  .composer {
    width: 100%;
    background: var(--surface);
    border: 1px solid #818385;
    border-radius: 8px;
    overflow: hidden;
    transition: border-color 0.15s;
  }

  .composer:focus-within {
    border-color: var(--border-focus);
  }

  /* ── Toolbar ── */
  .toolbar {
    display: flex;
    align-items: center;
    gap: 1px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }

  .toolbar-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 13px;
    font-family: inherit;
    transition: all 0.08s;
    position: relative;
    flex-shrink: 0;
  }

  .toolbar-btn:hover {
    background: var(--surface-raised);
    color: var(--text);
  }

  .toolbar-btn.active {
    background: var(--toolbar-active);
    color: var(--blue-link);
  }

  .toolbar-btn.disabled {
    opacity: 0.3;
    pointer-events: none;
  }

  .toolbar-btn svg { width: 16px; height: 16px; fill: currentColor; }
  .toolbar-btn .b  { font-weight: 800; font-size: 15px; line-height: 1; }
  .toolbar-btn .i  { font-style: italic; font-weight: 600; font-size: 15px; font-family: Georgia, serif; line-height: 1; }
  .toolbar-btn .s  { text-decoration: line-through; font-weight: 600; font-size: 13px; line-height: 1; }

  .toolbar-sep {
    width: 1px;
    height: 20px;
    background: var(--border);
    margin: 0 4px;
    flex-shrink: 0;
  }

  /* Tooltip */
  .toolbar-btn[data-tip]::after {
    content: attr(data-tip);
    position: absolute;
    bottom: calc(100% + 6px);
    left: 50%;
    transform: translateX(-50%);
    background: #1d1d1d;
    color: #e0e0e0;
    font-size: 11px;
    font-weight: 400;
    font-style: normal;
    text-decoration: none;
    padding: 4px 8px;
    border-radius: 6px;
    white-space: nowrap;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.12s;
    z-index: 20;
  }
  .toolbar-btn:hover[data-tip]::after { opacity: 1; }

  /* ── Editor ── */
  .editor {
    min-height: 200px;
    max-height: 55vh;
    overflow-y: auto;
    padding: 12px 16px;
    font-size: 15px;
    line-height: 1.46668;
    color: var(--text);
    outline: none;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }

  .editor:empty::before {
    content: attr(data-placeholder);
    color: var(--text-muted);
    pointer-events: none;
  }

  .editor b, .editor strong { font-weight: 700; }
  .editor i, .editor em { font-style: italic; }
  .editor s, .editor strike, .editor del { text-decoration: line-through; }

  .editor code {
    background: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 2px 4px;
    font-family: Monaco, Menlo, Consolas, 'Courier New', monospace;
    font-size: 12px;
    color: #e06c75;
  }

  .editor pre {
    background: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 8px 12px;
    margin: 4px 0;
    font-family: Monaco, Menlo, Consolas, 'Courier New', monospace;
    font-size: 12px;
    line-height: 1.5;
    overflow-x: auto;
    white-space: pre-wrap;
    color: var(--text);
  }

  .editor pre code {
    background: none;
    border: none;
    padding: 0;
    font-size: inherit;
    color: inherit;
  }

  /* Adjacent <pre> elements look like one code block (browser splits on Enter) */
  .editor pre + pre,
  .editor pre + br + pre {
    border-top: none;
    margin-top: -4px; /* collapse gap */
    padding-top: 0;
    border-top-left-radius: 0;
    border-top-right-radius: 0;
  }
  .editor pre:has(+ pre),
  .editor pre:has(+ br + pre) {
    border-bottom: none;
    margin-bottom: 0;
    padding-bottom: 0;
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
  }

  .editor blockquote {
    border-left: 4px solid var(--blockquote-border);
    padding: 4px 0 4px 16px;
    margin: 4px 0;
    color: var(--text-secondary);
  }

  .editor ul, .editor ol { padding-left: 26px; margin: 4px 0; }
  .editor li { margin: 2px 0; }
  .editor a { color: var(--blue-link); text-decoration: none; }
  .editor a:hover { text-decoration: underline; }

  /* ── Source textarea ── */
  .source-editor {
    display: none;
    min-height: 200px;
    max-height: 55vh;
    width: 100%;
    padding: 12px 16px;
    font-family: Monaco, Menlo, Consolas, 'Courier New', monospace;
    font-size: 13px;
    line-height: 1.5;
    background: var(--surface);
    color: var(--text);
    border: none;
    outline: none;
    resize: vertical;
  }

  /* ── Bottom bar ── */
  .bottom-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 10px;
    border-top: 1px solid var(--border);
    background: var(--surface);
  }

  .bottom-left {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .hint {
    font-size: 12px;
    color: var(--text-muted);
  }
  .hint kbd {
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 1px 4px;
    font-family: inherit;
    font-size: 11px;
  }

  .btn-send {
    background: var(--green);
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.1s;
    flex-shrink: 0;
  }
  .btn-send:hover { background: var(--green-hover); }
  .btn-send:disabled { opacity: 0.3; cursor: not-allowed; }
  .btn-send svg { width: 16px; height: 16px; fill: currentColor; }

  .cancel-link {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 12px;
    font-family: inherit;
    cursor: pointer;
    padding: 4px 6px;
  }
  .cancel-link:hover { color: var(--text-secondary); text-decoration: underline; }

  .btn-aa {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 14px;
    font-weight: 700;
    font-family: inherit;
    transition: all 0.08s;
    flex-shrink: 0;
  }
  .btn-aa:hover { background: var(--surface-raised); color: var(--text); }
  .btn-aa.active { background: var(--toolbar-active); color: var(--blue-link); }

  .btn-source {
    background: transparent;
    color: var(--text-muted);
    font-size: 11px;
    font-weight: 600;
    padding: 3px 6px;
    border-radius: 4px;
    border: 1px solid transparent;
    cursor: pointer;
    font-family: Monaco, Menlo, Consolas, monospace;
  }
  .btn-source:hover { color: var(--text-secondary); border-color: var(--border); }
  .btn-source.active { color: var(--blue-link); border-color: rgba(29,155,209,0.3); }

  /* ── Inline link popover (Slack-style two-field) ── */
  .link-popover {
    display: none;
    position: absolute;
    z-index: 30;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px 14px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    flex-direction: column;
    gap: 8px;
    width: 340px;
  }
  .link-popover.visible { display: flex; }

  .link-popover label {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-secondary);
    display: block;
    margin-bottom: 3px;
  }

  .link-popover input {
    width: 100%;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 6px 8px;
    font-size: 13px;
    color: var(--text);
    font-family: inherit;
    outline: none;
  }
  .link-popover input:focus { border-color: var(--border-focus); }
  .link-popover input::placeholder { color: var(--text-muted); }

  .link-popover .popover-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 2px;
  }

  .link-popover .popover-btn {
    border: none;
    border-radius: 4px;
    padding: 5px 12px;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
    font-family: inherit;
  }
  .link-popover .popover-btn-save {
    background: var(--green);
    color: #fff;
  }
  .link-popover .popover-btn-save:hover { background: var(--green-hover); }
  .link-popover .popover-btn-cancel {
    background: transparent;
    color: var(--text-muted);
  }
  .link-popover .popover-btn-cancel:hover { color: var(--text-secondary); }

  /* ── Result overlay ── */
  .overlay {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.8);
    z-index: 100;
    align-items: center;
    justify-content: center;
  }
  .overlay.visible { display: flex; }

  .overlay-msg {
    text-align: center;
    font-size: 18px;
    font-weight: 600;
  }
  .overlay-msg.success { color: #2eb67d; }
  .overlay-msg.error { color: var(--red); }
  .overlay-msg small {
    display: block;
    margin-top: 8px;
    font-size: 13px;
    font-weight: 400;
    color: var(--text-muted);
  }

  /* Scrollbar */
  .editor::-webkit-scrollbar { width: 6px; }
  .editor::-webkit-scrollbar-track { background: transparent; }
  .editor::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
</style>
</head>
<body>

<div class="page">
  <!-- Branding -->
  <div class="brand">
    <div class="brand-name">Agent Slack</div>
    <div class="brand-byline">By <a href="https://stably.ai" target="_blank" rel="noopener"><img src="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjM3OCIgaGVpZ2h0PSIyMzc4IiB2aWV3Qm94PSIwIDAgMjM3OCAyMzc4IiBmaWxsPSJub25lIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPgo8ZyBjbGlwLXBhdGg9InVybCgjY2xpcDBfMTZfNDcpIj4KPHBhdGggZD0iTTExODguOTQgNjE4LjY0NUMxNTAwLjY5IDYxOC42NDUgMTc1My4zNiA4NzEuMzIyIDE3NTMuMzYgMTE4My4wNEMxNzUzLjM2IDE0OTQuNzIgMTUwMC42OSAxNzQ3LjM5IDExODguOTQgMTc0Ny4zOUM4NzcuMjUyIDE3NDcuMzkgNjI0LjU0NyAxNDk0LjcyIDYyNC41NDcgMTE4My4wNEM2MjQuNTQ3IDg3MS4zMTcgODc3LjI1MiA2MTguNjQ1IDExODguOTQgNjE4LjY0NVoiIGZpbGw9IndoaXRlIi8+CjxwYXRoIGQ9Ik0xMTg4Ljk0IDBDMTA0MC44MSAwIDg5OS40NiAyOC40NTgxIDc2OC42MTkgNzguMTc0MkM3OTcuMjAyIDEwNy4yMDMgODIwLjg0IDE0MC45OTIgODM4Ljk5IDE3OC4wNTJDOTQ4Ljg2MSAxMzkuODE4IDEwNjYuMzUgMTE4LjA1NSAxMTg5IDExOC4wNTVDMTc3OS41IDExOC4wNTUgMjI1OS44NSA1OTguNTYxIDIyNTkuODUgMTE4OC45NEMyMjU5Ljg1IDE3NzkuMzEgMTc3OS41IDIyNTkuOTEgMTE4OC45NCAyMjU5LjkxQzU5OC41MDEgMjI1OS45MSAxMTguMTIgMTc3OS4zNyAxMTguMTIgMTE4OUMxMTguMTIgOTkwLjEwNiAxNzMuNjA3IDgwNC40MDggMjY4LjQwOSA2NDQuNjNDMjM1LjkxOSA2MTkuNzU5IDIwNy4yNzEgNTg5LjkzNyAxODQuMzI4IDU1NS45NThDNjguMjEzNiA3MzkuNDkzIDAgOTU2LjE4NiAwIDExODlDMCAxODQ0LjYgNTMzLjMzIDIzNzguMDEgMTE4OC45NCAyMzc4LjAxQzE4NDQuNiAyMzc4LjAxIDIzNzggMTg0NC42MSAyMzc4IDExODlDMjM3OCA1MzMuMzk1IDE4NDQuNiAwIDExODguOTQgMFoiIGZpbGw9IndoaXRlIi8+CjxwYXRoIGQ9Ik00OTguNjI0IDExMS4xMUM2MzMuMjA5IDExMS4xMSA3NDIuMjg3IDIyMC4xODggNzQyLjI4NyAzNTQuNzczQzc0Mi4yODcgNDg5LjM1OCA2MzMuMjA5IDU5OC40MzYgNDk4LjYyNCA1OTguNDM2QzM2NC4wNzEgNTk4LjQzNiAyNTQuOTYxIDQ4OS4zNTggMjU0Ljk2MSAzNTQuNzczQzI1NC45NjEgMjIwLjE4OCAzNjQuMDcxIDExMS4xMSA0OTguNjI0IDExMS4xMVoiIGZpbGw9IndoaXRlIi8+CjwvZz4KPGRlZnM+CjxjbGlwUGF0aCBpZD0iY2xpcDBfMTZfNDciPgo8cmVjdCB3aWR0aD0iMjM3OCIgaGVpZ2h0PSIyMzc4IiBmaWxsPSJ3aGl0ZSIvPgo8L2NsaXBQYXRoPgo8L2RlZnM+Cjwvc3ZnPgo=" alt="" /></a><a href="https://stably.ai" target="_blank" rel="noopener">Stably.ai</a></div>
    <div class="brand-sub">draft mode</div>
  </div>

  <!-- Context: channel + thread link -->
  <div class="context-bar">
    <svg class="hash-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
      <line x1="7.5" y1="2" x2="6" y2="18"/><line x1="14" y1="2" x2="12.5" y2="18"/>
      <line x1="3" y1="7" x2="17.5" y2="7"/><line x1="2.5" y1="13" x2="17" y2="13"/>
    </svg>
    <span class="channel" id="channelName"></span>
    <span class="workspace-label" id="workspaceName"></span>
    <a class="thread-link" id="threadLink" style="display:none" target="_blank">
      <span>View thread</span>
      <svg viewBox="0 0 16 16" stroke-linecap="round" stroke-linejoin="round">
        <path d="M6 3h7v7"/><path d="M13 3L6 10"/>
      </svg>
    </a>
  </div>

  <!-- Composer -->
  <div class="composer">
    <div class="toolbar" id="toolbar">
      <button class="toolbar-btn" data-cmd="bold"               data-tip="Bold (&#8984;B)"><span class="b">B</span></button>
      <button class="toolbar-btn" data-cmd="italic"             data-tip="Italic (&#8984;I)"><span class="i">I</span></button>
      <button class="toolbar-btn" data-cmd="strikethrough"      data-tip="Strikethrough (&#8984;&#8679;X)"><span class="s">S</span></button>
      <div class="toolbar-sep"></div>
      <button class="toolbar-btn" data-cmd="link"               data-tip="Link (&#8984;K)">
        <svg viewBox="0 0 16 16"><path d="M6.354 5.5H4a3 3 0 0 0 0 6h3a3 3 0 0 0 2.83-4M9.646 10.5H12a3 3 0 0 0 0-6H9a3 3 0 0 0-2.83 4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
      </button>
      <div class="toolbar-sep"></div>
      <button class="toolbar-btn" data-cmd="insertOrderedList"  data-tip="Numbered list (&#8984;&#8679;7)">
        <svg viewBox="0 0 16 16"><text x="1" y="5" font-size="5" fill="currentColor" font-family="system-ui" font-weight="600">1.</text><line x1="7" y1="3.5" x2="15" y2="3.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><text x="1" y="10" font-size="5" fill="currentColor" font-family="system-ui" font-weight="600">2.</text><line x1="7" y1="8.5" x2="15" y2="8.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><text x="1" y="15" font-size="5" fill="currentColor" font-family="system-ui" font-weight="600">3.</text><line x1="7" y1="13.5" x2="15" y2="13.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
      </button>
      <button class="toolbar-btn" data-cmd="insertUnorderedList" data-tip="Bulleted list (&#8984;&#8679;8)">
        <svg viewBox="0 0 16 16"><circle cx="3" cy="3.5" r="1.5" fill="currentColor"/><line x1="7" y1="3.5" x2="15" y2="3.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="3" cy="8.5" r="1.5" fill="currentColor"/><line x1="7" y1="8.5" x2="15" y2="8.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="3" cy="13.5" r="1.5" fill="currentColor"/><line x1="7" y1="13.5" x2="15" y2="13.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
      </button>
      <div class="toolbar-sep"></div>
      <button class="toolbar-btn" data-cmd="blockquote"          data-tip="Quote (&#8984;&#8679;9)">
        <svg viewBox="0 0 16 16"><rect x="1" y="2" width="2.5" height="12" rx="1" fill="currentColor" opacity="0.5"/><line x1="6" y1="4" x2="15" y2="4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><line x1="6" y1="8" x2="13" y2="8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><line x1="6" y1="12" x2="11" y2="12" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
      </button>
      <div class="toolbar-sep"></div>
      <button class="toolbar-btn" data-cmd="code"                data-tip="Code (&#8984;E)">
        <svg viewBox="0 0 16 16"><polyline points="5,3 1,8 5,13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><polyline points="11,3 15,8 11,13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <button class="toolbar-btn" data-cmd="codeblock"           data-tip="Code block (&#8984;&#8679;C)">
        <svg viewBox="0 0 16 16"><rect x="1" y="1" width="14" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.2"/><polyline points="5,5 3,8 5,11" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/><polyline points="11,5 13,8 11,11" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </div>

    <div
      class="editor"
      id="editor"
      contenteditable="true"
      data-placeholder="Message #channel"
      spellcheck="true"
    ></div>

    <textarea class="source-editor" id="sourceEditor" spellcheck="false"></textarea>

    <div class="bottom-bar">
      <div class="bottom-left">
        <button class="btn-aa active" id="aaToggle" onclick="toggleToolbar()" data-tip="Formatting">Aa</button>
        <button class="btn-source" id="sourceToggle" onclick="toggleSourceMode()">mrkdwn</button>
        <span class="hint"><kbd id="modKey">&#8984;</kbd><kbd>Enter</kbd> to send</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <button class="cancel-link" onclick="handleCancel()">Cancel</button>
        <button class="btn-send" id="sendBtn" onclick="handleSend()" disabled>
          <svg viewBox="0 0 20 20"><path d="M1.7 9.1l7.3 1 .01 0L1.7 9.1zm0 1.8l7.3-1-7.3 1zM1.5 2.1c-.2-.7.5-1.3 1.1-1L19 8.9c.6.3.6 1.2 0 1.5L2.6 18.9c-.7.3-1.3-.3-1.1-1l1.8-6.9L11 10 3.3 8.9 1.5 2.1z"/></svg>
        </button>
      </div>
    </div>
  </div>
</div>

<!-- Inline link popover (Slack-style two-field) -->
<div class="link-popover" id="linkPopover">
  <div>
    <label>Text</label>
    <input type="text" id="linkTextInput" placeholder="Display text">
  </div>
  <div>
    <label>Link</label>
    <input type="text" id="linkUrlInput" placeholder="https://example.com">
  </div>
  <div class="popover-actions">
    <button class="popover-btn popover-btn-cancel" onclick="closeLinkPopover()">Cancel</button>
    <button class="popover-btn popover-btn-save" onclick="applyLink()">Save</button>
  </div>
</div>

<!-- Result overlay -->
<div class="overlay" id="resultOverlay">
  <div class="overlay-msg" id="resultMsg"></div>
</div>

<script>
// ─── Config ───
const CONFIG = __DRAFT_CONFIG__;
const IS_MAC = /Mac|iPhone/.test(navigator.platform);
const MOD = IS_MAC ? 'metaKey' : 'ctrlKey';

// ─── Init header ───
document.getElementById('channelName').textContent = CONFIG.channelName;
if (CONFIG.workspaceName) {
  document.getElementById('workspaceName').textContent = CONFIG.workspaceName;
}
if (!IS_MAC) {
  document.getElementById('modKey').textContent = 'Ctrl';
  document.querySelectorAll('[data-tip]').forEach(el => {
    el.dataset.tip = el.dataset.tip.replace(/\\u2318/g, 'Ctrl+').replace(/\\u21E7/g, 'Shift+');
  });
}
if (CONFIG.threadTs) {
  const link = document.getElementById('threadLink');
  link.style.display = '';
  if (CONFIG.threadUrl) {
    link.href = CONFIG.threadUrl;
  } else {
    link.removeAttribute('href');
    link.style.cursor = 'default';
    link.style.color = 'var(--text-muted)';
  }
}

// ─── Editor refs ───
const editor = document.getElementById('editor');
const sourceEditor = document.getElementById('sourceEditor');
const linkPopover = document.getElementById('linkPopover');
const linkUrlInput = document.getElementById('linkUrlInput');
let sourceMode = false;

// Set Slack-style placeholder
editor.dataset.placeholder = 'Message #' + CONFIG.channelName;

// ─── Detect if cursor is inside a code element ───
function isInsideCode(node) {
  let el = node;
  while (el && el !== editor) {
    if (el.nodeType === 1) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'pre' || tag === 'code') { return true; }
    }
    el = el.parentNode;
  }
  return false;
}

function cursorInCode() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) { return false; }
  return isInsideCode(sel.anchorNode);
}

// ─── mrkdwn to HTML (initial content) ───
function escapeHtml(t) {
  return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function mrkdwnToHtml(text) {
  if (!text) { return ''; }
  const codeBlocks = [];
  text = text.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, (_, code) => {
    codeBlocks.push('<pre>' + escapeHtml(code.trim()) + '</pre>');
    return '\\x00CB' + (codeBlocks.length - 1) + '\\x00';
  });
  const inlineCodes = [];
  text = text.replace(/\`([^\`\\n]+)\`/g, (_, code) => {
    inlineCodes.push('<code>' + escapeHtml(code) + '</code>');
    return '\\x00IC' + (inlineCodes.length - 1) + '\\x00';
  });

  const lines = text.split('\\n');
  let html = '', idx = 0;
  while (idx < lines.length) {
    const line = lines[idx];
    if (line.startsWith('> ')) {
      const q = [];
      while (idx < lines.length && lines[idx].startsWith('> ')) { q.push(fmtInline(lines[idx].slice(2))); idx++; }
      html += '<blockquote>' + q.join('<br>') + '</blockquote>'; continue;
    }
    if (/^[\\u2022\\-\\*] /.test(line)) {
      const items = [];
      while (idx < lines.length && /^[\\u2022\\-\\*] /.test(lines[idx])) { items.push('<li>' + fmtInline(lines[idx].replace(/^[\\u2022\\-\\*] /, '')) + '</li>'); idx++; }
      html += '<ul>' + items.join('') + '</ul>'; continue;
    }
    if (/^\\d+[\\.\\)] /.test(line)) {
      const items = [];
      while (idx < lines.length && /^\\d+[\\.\\)] /.test(lines[idx])) { items.push('<li>' + fmtInline(lines[idx].replace(/^\\d+[\\.\\)] /, '')) + '</li>'); idx++; }
      html += '<ol>' + items.join('') + '</ol>'; continue;
    }
    html += (line ? fmtInline(line) : '') + '<br>';
    idx++;
  }
  codeBlocks.forEach((b, i) => { html = html.replace('\\x00CB' + i + '\\x00', b); });
  inlineCodes.forEach((c, i) => { html = html.replace('\\x00IC' + i + '\\x00', c); });
  return html.replace(/(<br>)+$/, '');
}

function fmtInline(t) {
  t = t.replace(/<(https?:\\/\\/[^|>]+)\\|([^>]+)>/g, '<a href="$1" target="_blank">$2</a>');
  t = t.replace(/<(https?:\\/\\/[^>]+)>/g, '<a href="$1" target="_blank">$1</a>');
  t = t.replace(/\\*([^\\*]+)\\*/g, '<b>$1</b>');
  t = t.replace(/(?<![a-zA-Z0-9])_([^_]+)_(?![a-zA-Z0-9])/g, '<i>$1</i>');
  t = t.replace(/~([^~]+)~/g, '<s>$1</s>');
  return t;
}

// ─── HTML to mrkdwn (submission) ───
function htmlToMrkdwn(root) {
  const visited = new Set();
  function walk(node) {
    if (visited.has(node)) { return ''; }
    if (node.nodeType === 3) { return node.textContent || ''; }
    if (node.nodeType !== 1) { return ''; }
    const el = node;
    const tag = el.tagName.toLowerCase();
    const kids = () => Array.from(el.childNodes).map(walk).join('');
    switch (tag) {
      case 'b': case 'strong': { const c = kids(); return c.trim() ? '*' + c + '*' : c; }
      case 'i': case 'em':     { const c = kids(); return c.trim() ? '_' + c + '_' : c; }
      case 's': case 'strike': case 'del': { const c = kids(); return c.trim() ? '~' + c + '~' : c; }
      case 'code': return '\`' + (el.textContent || '') + '\`';
      case 'pre': {
        // Collect adjacent pres into one code block
        const lines = [(el.textContent || '').trimEnd()];
        let next = el.nextElementSibling;
        while (next && next.tagName === 'PRE') {
          lines.push((next.textContent || '').trimEnd());
          visited.add(next);
          next = next.nextElementSibling;
        }
        return '\`\`\`\\n' + lines.filter(l => l).join('\\n') + '\\n\`\`\`\\n';
      }
      case 'blockquote': { const c = kids().trim(); return c.split('\\n').map(l => '> ' + l).join('\\n') + '\\n'; }
      case 'ul': { let r = ''; for (const li of el.querySelectorAll(':scope > li')) { r += '\\u2022 ' + walk(li).trim() + '\\n'; } return r; }
      case 'ol': { let r = '', n = 1; for (const li of el.querySelectorAll(':scope > li')) { r += n + '. ' + walk(li).trim() + '\\n'; n++; } return r; }
      case 'li': return kids();
      case 'a':  { const h = el.getAttribute('href'); const t = kids(); return (h && t && h !== t) ? '<' + h + '|' + t + '>' : (h || t); }
      case 'br': return '\\n';
      case 'div': case 'p': {
        const c = kids();
        const p = el.parentElement;
        if (p && ['li','blockquote','td'].includes(p.tagName.toLowerCase())) { return c; }
        return c.endsWith('\\n') ? c : c + '\\n';
      }
      case 'span': {
        const st = el.style;
        let c = kids();
        if (st.fontWeight === 'bold' || Number(st.fontWeight) >= 700) { c = c.trim() ? '*' + c + '*' : c; }
        if (st.fontStyle === 'italic') { c = c.trim() ? '_' + c + '_' : c; }
        if (st.textDecoration && st.textDecoration.includes('line-through')) { c = c.trim() ? '~' + c + '~' : c; }
        return c;
      }
      default: return kids();
    }
  }
  return walk(root).replace(/\\n{3,}/g, '\\n\\n').trim();
}

// ─── Init editor content ───
if (CONFIG.initialText) { editor.innerHTML = mrkdwnToHtml(CONFIG.initialText); }

// ─── Toolbar execution ───
function execCmd(command) {
  // Block formatting inside code (except toggling code off)
  const inCode = cursorInCode();
  if (inCode && command !== 'code' && command !== 'codeblock') { return; }

  switch (command) {
    case 'bold':
    case 'italic':
    case 'strikethrough':
    case 'insertOrderedList':
    case 'insertUnorderedList':
      document.execCommand(command, false, null);
      break;
    case 'blockquote':
      document.execCommand('formatBlock', false, 'blockquote');
      break;
    case 'code': {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) { break; }
      // If already in code, unwrap
      if (inCode) {
        const codeEl = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
        const code = codeEl.closest('code');
        if (code) {
          const text = document.createTextNode(code.textContent || '');
          code.parentNode.replaceChild(text, code);
          const r = document.createRange(); r.selectNodeContents(text); sel.removeAllRanges(); sel.addRange(r);
        }
        break;
      }
      const range = sel.getRangeAt(0);
      if (range.collapsed) { break; }
      const code = document.createElement('code');
      try { range.surroundContents(code); } catch (_) {
        const frag = range.extractContents(); code.appendChild(frag); range.insertNode(code);
      }
      sel.removeAllRanges();
      const nr = document.createRange(); nr.selectNodeContents(code); sel.addRange(nr);
      break;
    }
    case 'codeblock': {
      if (inCode) { break; } // No nesting
      const sel = window.getSelection();
      if (!sel) { break; }
      const pre = document.createElement('pre');
      if (!sel.isCollapsed) {
        const range = sel.getRangeAt(0);
        pre.textContent = range.extractContents().textContent || '';
        range.insertNode(pre);
      } else {
        pre.innerHTML = '<br>';
        const range = sel.getRangeAt(0);
        range.insertNode(pre);
        const nr = document.createRange(); nr.setStart(pre, 0); nr.collapse(true);
        sel.removeAllRanges(); sel.addRange(nr);
      }
      break;
    }
    case 'link':
      openLinkPopover();
      return; // Don't refocus — popover takes focus
  }
  editor.focus();
  updateToolbarState();
}

// Toolbar button clicks
document.querySelectorAll('.toolbar-btn[data-cmd]').forEach(btn => {
  btn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    execCmd(btn.dataset.cmd);
  });
});

// ─── Toolbar state ───
function updateToolbarState() {
  const inCode = cursorInCode();
  document.querySelectorAll('.toolbar-btn[data-cmd]').forEach(btn => {
    const cmd = btn.dataset.cmd;
    // Disable non-code buttons when inside code
    if (inCode && cmd !== 'code' && cmd !== 'codeblock') {
      btn.classList.add('disabled');
      btn.classList.remove('active');
      return;
    }
    btn.classList.remove('disabled');
    let active = false;
    try {
      if (['bold','italic','strikethrough','insertOrderedList','insertUnorderedList'].includes(cmd)) {
        active = document.queryCommandState(cmd);
      }
      if (cmd === 'code') { active = inCode; }
    } catch (_) {}
    btn.classList.toggle('active', active);
  });
}

editor.addEventListener('keyup', updateToolbarState);
editor.addEventListener('mouseup', updateToolbarState);
editor.addEventListener('focus', updateToolbarState);

// ─── Keyboard shortcuts (Slack-identical) ───
editor.addEventListener('keydown', (e) => {
  const mod = e[MOD];

  // Cmd+Enter → Send
  if (mod && e.key === 'Enter') { e.preventDefault(); handleSend(); return; }

  // Cmd+B → Bold
  if (mod && !e.shiftKey && e.key === 'b') { e.preventDefault(); execCmd('bold'); return; }

  // Cmd+I → Italic
  if (mod && !e.shiftKey && e.key === 'i') { e.preventDefault(); execCmd('italic'); return; }

  // Cmd+Shift+X → Strikethrough
  if (mod && e.shiftKey && (e.key === 'X' || e.key === 'x')) { e.preventDefault(); execCmd('strikethrough'); return; }

  // Cmd+E → Inline code (Slack's actual shortcut)
  if (mod && !e.shiftKey && e.key === 'e') { e.preventDefault(); execCmd('code'); return; }

  // Cmd+Shift+C → Code block
  if (mod && e.shiftKey && (e.key === 'C' || e.key === 'c' || e.code === 'KeyC')) { e.preventDefault(); execCmd('codeblock'); return; }

  // Cmd+K → Link
  if (mod && !e.shiftKey && e.key === 'k') { e.preventDefault(); execCmd('link'); return; }

  // Cmd+Shift+7 → Numbered list
  if (mod && e.shiftKey && e.key === '7') { e.preventDefault(); execCmd('insertOrderedList'); return; }

  // Cmd+Shift+8 → Bulleted list
  if (mod && e.shiftKey && e.key === '8') { e.preventDefault(); execCmd('insertUnorderedList'); return; }

  // Cmd+Shift+9 → Blockquote
  if (mod && e.shiftKey && e.key === '9') { e.preventDefault(); execCmd('blockquote'); return; }
});

// ─── Code block: merge split <pre> elements + escape logic ───
function findParentPre(node) {
  while (node && node !== editor) {
    if (node.nodeType === 1 && node.tagName === 'PRE') { return node; }
    node = node.parentNode;
  }
  return null;
}

function exitCodeBlock(pre) {
  const sel = window.getSelection();
  const p = document.createElement('div');
  p.innerHTML = '<br>';
  if (pre.parentNode === editor) {
    pre.parentNode.insertBefore(p, pre.nextSibling);
  } else {
    const wrapper = pre.parentNode;
    wrapper.parentNode.insertBefore(p, wrapper.nextSibling);
  }
  const nr = document.createRange();
  nr.setStart(p, 0);
  nr.collapse(true);
  sel.removeAllRanges();
  sel.addRange(nr);
}

// Code block management: the browser splits <pre> on Enter, creating adjacent
// <pre> elements. We let this happen and handle it via:
// 1. CSS: adjacent pres look like one block (no gaps/borders between them)
// 2. Serialization: htmlToMrkdwn treats adjacent pres as one code block
// 3. Escape: when user creates an empty pre after another empty pre, exit code

// Track code block escape (double-Enter on empty line)
editor.addEventListener('input', () => {
  const pres = Array.from(editor.querySelectorAll('pre'));
  if (pres.length < 2) { return; }

  // Check for escape: last two adjacent pres are both empty
  for (let i = pres.length - 1; i > 0; i--) {
    const cur = pres[i];
    const prev = pres[i - 1];
    const curEmpty = !cur.textContent?.trim();
    const prevEmpty = !prev.textContent?.trim();

    if (curEmpty && prevEmpty) {
      // Double-Enter escape: remove both empty pres, place cursor after
      const lastRealPre = pres[i - 2] || null;
      // Remove the two empty pres and their wrappers
      [cur, prev].forEach(p => {
        const parent = p.parentNode;
        p.remove();
        if (parent && parent !== editor && parent.tagName === 'DIV' && !parent.textContent?.trim()) {
          parent.remove();
        }
      });
      if (lastRealPre) {
        exitCodeBlock(lastRealPre);
      } else {
        // No code left — just place cursor
        const sel = window.getSelection();
        if (sel) {
          const div = document.createElement('div');
          div.innerHTML = '<br>';
          editor.appendChild(div);
          const r = document.createRange();
          r.setStart(div, 0);
          r.collapse(true);
          sel.removeAllRanges();
          sel.addRange(r);
        }
      }
      return;
    }
  }
});

// ArrowDown at end of last code block → exit
editor.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) { return; }
    const pre = findParentPre(sel.anchorNode);
    if (pre && !pre.nextElementSibling) {
      e.preventDefault();
      exitCodeBlock(pre);
    }
  }
}, true);

// ─── Paste handler ───
editor.addEventListener('paste', (e) => {
  const cd = e.clipboardData;
  if (!cd) { return; }
  const html = cd.getData('text/html');
  if (html) {
    e.preventDefault();
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    tmp.querySelectorAll('script,style,meta,link').forEach(el => el.remove());
    tmp.querySelectorAll('[style]').forEach(el => {
      const s = el.style;
      const keep = {};
      if (s.fontWeight === 'bold' || Number(s.fontWeight) >= 700) { keep.fontWeight = s.fontWeight; }
      if (s.fontStyle === 'italic') { keep.fontStyle = s.fontStyle; }
      if (s.textDecoration?.includes('line-through')) { keep.textDecoration = 'line-through'; }
      el.removeAttribute('style');
      Object.assign(el.style, keep);
    });
    document.execCommand('insertHTML', false, tmp.innerHTML);
  }
});

// ─── Link popover (Slack-style: select text, Cmd+K, two-field form) ───
let linkSavedRange = null;
let linkPopoverOpen = false;
const linkTextInput = document.getElementById('linkTextInput');

function openLinkPopover() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) { return; }

  linkSavedRange = sel.getRangeAt(0).cloneRange();
  const selectedText = sel.toString();

  // Position near selection
  const rect = linkSavedRange.getBoundingClientRect();
  const editorRect = editor.getBoundingClientRect();
  linkPopover.style.top = (rect.bottom + window.scrollY + 6) + 'px';
  linkPopover.style.left = Math.max(8, Math.min(rect.left + window.scrollX, editorRect.right - 360)) + 'px';

  // Pre-fill text field with selected text
  linkTextInput.value = selectedText;

  // If selection is already a link, pre-fill URL
  let existingUrl = '';
  const anchor = sel.anchorNode?.parentElement?.closest('a');
  if (anchor) {
    existingUrl = anchor.getAttribute('href') || '';
    linkTextInput.value = anchor.textContent || selectedText;
  }
  linkUrlInput.value = existingUrl;

  // Show popover (use rAF to avoid same-frame mousedown closing it)
  requestAnimationFrame(() => {
    linkPopover.classList.add('visible');
    linkPopoverOpen = true;
    linkUrlInput.focus();
    linkUrlInput.select();
  });
}

function closeLinkPopover() {
  linkPopover.classList.remove('visible');
  linkPopoverOpen = false;
  editor.focus();
  if (linkSavedRange) {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(linkSavedRange);
  }
}

function applyLink() {
  const url = linkUrlInput.value.trim();
  const text = linkTextInput.value.trim();
  linkPopover.classList.remove('visible');
  linkPopoverOpen = false;

  if (!url || !linkSavedRange) { editor.focus(); return; }

  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(linkSavedRange);

  // Check if we're updating an existing link
  const anchor = sel.anchorNode?.parentElement?.closest('a');
  if (anchor) {
    anchor.setAttribute('href', url);
    if (text) { anchor.textContent = text; }
  } else {
    // Create new link
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.textContent = text || url;

    if (!linkSavedRange.collapsed) {
      linkSavedRange.deleteContents();
    }
    linkSavedRange.insertNode(a);

    const nr = document.createRange();
    nr.setStartAfter(a);
    nr.collapse(true);
    sel.removeAllRanges();
    sel.addRange(nr);
  }

  editor.focus();
  linkSavedRange = null;
}

// Popover key handling — both inputs
[linkTextInput, linkUrlInput].forEach(input => {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); applyLink(); }
    if (e.key === 'Escape') { e.preventDefault(); closeLinkPopover(); }
  });
});

// Close popover on outside click (delayed check to avoid same-event close)
document.addEventListener('mousedown', (e) => {
  if (linkPopoverOpen && !linkPopover.contains(e.target) && !e.target.closest('.toolbar-btn')) {
    closeLinkPopover();
  }
});

// ─── Toolbar toggle (Aa button) ───
let toolbarVisible = true;
function toggleToolbar() {
  toolbarVisible = !toolbarVisible;
  document.getElementById('toolbar').style.display = toolbarVisible ? '' : 'none';
  document.getElementById('aaToggle').classList.toggle('active', toolbarVisible);
}

// ─── Send button state ───
function updateSendBtn() {
  const text = sourceMode ? sourceEditor.value.trim() : (editor.textContent || '').trim();
  document.getElementById('sendBtn').disabled = !text;
}
editor.addEventListener('input', updateSendBtn);

// ─── Source mode ───
function toggleSourceMode() {
  sourceMode = !sourceMode;
  document.getElementById('sourceToggle').classList.toggle('active', sourceMode);
  if (sourceMode) {
    sourceEditor.value = htmlToMrkdwn(editor);
    editor.style.display = 'none';
    sourceEditor.style.display = 'block';
    document.getElementById('toolbar').style.display = 'none';
    document.getElementById('aaToggle').style.display = 'none';
    sourceEditor.focus();
  } else {
    editor.innerHTML = mrkdwnToHtml(sourceEditor.value);
    sourceEditor.style.display = 'none';
    editor.style.display = '';
    document.getElementById('toolbar').style.display = toolbarVisible ? '' : 'none';
    document.getElementById('aaToggle').style.display = '';
    editor.focus();
  }
  updateSendBtn();
}

sourceEditor.addEventListener('keydown', (e) => {
  if (e[MOD] && e.key === 'Enter') { e.preventDefault(); handleSend(); }
});
sourceEditor.addEventListener('input', updateSendBtn);

// ─── Send / Cancel ───
let sending = false;

async function handleSend() {
  if (sending) { return; }
  const text = sourceMode ? sourceEditor.value.trim() : htmlToMrkdwn(editor);
  if (!text) { editor.focus(); return; }

  sending = true;
  const btn = document.getElementById('sendBtn');
  btn.disabled = true;
  btn.innerHTML = '\\u2026';

  try {
    const resp = await fetch('/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await resp.json();
    if (data.ok) {
      let sub = 'You can close this tab.';
      if (data.ts && CONFIG.workspaceUrl && CONFIG.channelId) {
        const tsNoDot = data.ts.replace('.', '');
        const baseUrl = CONFIG.workspaceUrl.replace(/\\/$/, '');
        const msgUrl = baseUrl + '/archives/' + CONFIG.channelId + '/p' + tsNoDot;
        sub = '<a href="' + msgUrl + '" target="_blank" style="color:var(--accent);text-decoration:none;">View in Slack \\u2197</a><br><span style="opacity:0.6;font-size:12px;">You can close this tab.</span>';
      }
      showOverlay('Message sent \\u2705', sub, 'success');
    } else {
      throw new Error(data.error || 'Send failed');
    }
  } catch (err) {
    showOverlay('Failed to send', err.message, 'error');
    sending = false;
    btn.disabled = false;
    btn.innerHTML = '<svg viewBox="0 0 20 20" style="width:16px;height:16px;fill:currentColor"><path d="M1.7 9.1l7.3 1 .01 0L1.7 9.1zm0 1.8l7.3-1-7.3 1zM1.5 2.1c-.2-.7.5-1.3 1.1-1L19 8.9c.6.3.6 1.2 0 1.5L2.6 18.9c-.7.3-1.3-.3-1.1-1l1.8-6.9L11 10 3.3 8.9 1.5 2.1z"/></svg>';
  }
}

async function handleCancel() {
  try { await fetch('/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch (_) {}
  showOverlay('Draft cancelled', 'You can close this tab.', 'success');
}

function showOverlay(title, sub, type) {
  const overlay = document.getElementById('resultOverlay');
  const msg = document.getElementById('resultMsg');
  msg.className = 'overlay-msg ' + type;
  msg.innerHTML = title + '<small>' + sub + '</small>';
  overlay.classList.add('visible');
}

// ─── Focus ───
editor.focus();
updateSendBtn();
</script>
</body>
</html>`;
