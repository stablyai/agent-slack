import { Command } from "commander";
import { parseSlackMessageUrl } from "./slack/url.ts";
import { extractFromChrome } from "./auth/chrome.ts";
import {
  upsertWorkspace,
  upsertWorkspaces,
  loadCredentials,
  removeWorkspace,
  setDefaultWorkspace,
  resolveWorkspaceForUrl,
  resolveDefaultWorkspace,
} from "./auth/store.ts";
import { SlackApiClient, type SlackAuth } from "./slack/client.ts";
import {
  fetchMessage,
  fetchThread,
  toCompactMessage,
} from "./slack/messages.ts";
import { downloadSlackFile } from "./slack/files.ts";
import { redactSecret } from "./lib/redact.ts";
import { parseSlackCurlCommand } from "./auth/curl.ts";
import { extractViaSlackTokens } from "./auth/slacktokens.ts";
import { existsSync } from "node:fs";
import { extractFromSlackDesktop } from "./auth/desktop.ts";
import { pruneEmpty } from "./lib/compact-json.ts";
import { ensureDownloadsDir } from "./lib/tmp-paths.ts";
import { parseMsgTarget } from "./cli/targets.ts";
import { normalizeChannelInput, resolveChannelId } from "./slack/channels.ts";
import type { CompactSlackMessage } from "./slack/messages.ts";
import { fetchCanvasMarkdown, parseSlackCanvasUrl } from "./slack/canvas.ts";
import { searchSlack } from "./slack/search.ts";

function isEnvAuthConfigured(): boolean {
  return Boolean(process.env.SLACK_TOKEN?.trim());
}

function effectiveWorkspaceUrl(flag?: string): string | undefined {
  return flag?.trim() || process.env.SLACK_WORKSPACE_URL?.trim() || undefined;
}

async function assertWorkspaceSpecifiedForChannelNames(
  workspaceUrl: string | undefined,
  channels: string[],
): Promise<void> {
  const hasName = channels.some(
    (c) => normalizeChannelInput(c).kind === "name",
  );
  if (!hasName) return;

  const creds = await loadCredentials();
  if ((creds.workspaces?.length ?? 0) <= 1) return;

  if (!workspaceUrl) {
    throw new Error(
      'Ambiguous channel name across multiple workspaces. Pass --workspace "https://...slack.com" (or set SLACK_WORKSPACE_URL).',
    );
  }
}

function isAuthErrorMessage(message: string): boolean {
  return /(?:^|[^a-z])(invalid_auth|token_expired)(?:$|[^a-z])/i.test(message);
}

async function refreshFromDesktopIfPossible(): Promise<void> {
  const extracted = await extractFromSlackDesktop();
  await upsertWorkspaces(
    extracted.teams.map((team) => ({
      workspace_url: normalizeUrl(team.url),
      workspace_name: team.name,
      auth: {
        auth_type: "browser" as const,
        xoxc_token: team.token,
        xoxd_cookie: extracted.cookie_d,
      },
    })),
  );
}

async function withAutoRefresh<T>(
  workspaceUrl: string | undefined,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (err: any) {
    const message = String(err?.message ?? err);
    if (isEnvAuthConfigured()) throw err;
    if (!isAuthErrorMessage(message)) throw err;

    await refreshFromDesktopIfPossible();
    return await work();
  }
}

function pickAuthFromEnv(): SlackAuth | null {
  const token = process.env.SLACK_TOKEN?.trim();
  if (!token) return null;
  if (token.startsWith("xoxc-")) {
    const cookie = (
      process.env.SLACK_COOKIE_D ||
      process.env.SLACK_COOKIE ||
      ""
    ).trim();
    if (!cookie)
      throw new Error(
        "SLACK_TOKEN looks like xoxc- but SLACK_COOKIE_D is missing",
      );
    return { auth_type: "browser", xoxc_token: token, xoxd_cookie: cookie };
  }
  return { auth_type: "standard", token };
}

async function getClientForWorkspace(workspaceUrl?: string): Promise<{
  client: SlackApiClient;
  auth: SlackAuth;
  workspace_url?: string;
}> {
  const env = pickAuthFromEnv();
  if (env) {
    const envWorkspaceUrl = process.env.SLACK_WORKSPACE_URL?.trim();
    const urlForBrowser = workspaceUrl || envWorkspaceUrl;
    return {
      client: new SlackApiClient(env, { workspaceUrl: urlForBrowser }),
      auth: env,
      workspace_url: urlForBrowser,
    };
  }

  if (workspaceUrl) {
    const ws = await resolveWorkspaceForUrl(workspaceUrl);
    if (ws)
      return {
        client: new SlackApiClient(ws.auth as SlackAuth, {
          workspaceUrl: ws.workspace_url,
        }),
        auth: ws.auth as SlackAuth,
        workspace_url: ws.workspace_url,
      };
  }

  const def = await resolveDefaultWorkspace();
  if (def)
    return {
      client: new SlackApiClient(def.auth as SlackAuth, {
        workspaceUrl: def.workspace_url,
      }),
      auth: def.auth as SlackAuth,
      workspace_url: def.workspace_url,
    };

  // Default: try Slack Desktop extraction (macOS). Does not require quitting Slack.
  try {
    const extracted = await extractFromSlackDesktop();
    await upsertWorkspaces(
      extracted.teams.map((team) => ({
        workspace_url: normalizeUrl(team.url),
        workspace_name: team.name,
        auth: {
          auth_type: "browser" as const,
          xoxc_token: team.token,
          xoxd_cookie: extracted.cookie_d,
        },
      })),
    );

    const desired = workspaceUrl
      ? await resolveWorkspaceForUrl(workspaceUrl)
      : await resolveDefaultWorkspace();
    const chosen = desired ?? (await resolveDefaultWorkspace());
    if (chosen) {
      return {
        client: new SlackApiClient(chosen.auth as SlackAuth, {
          workspaceUrl: chosen.workspace_url,
        }),
        auth: chosen.auth as SlackAuth,
        workspace_url: chosen.workspace_url,
      };
    }
  } catch {
    // Fall through to Chrome extraction.
  }

  // Fallback: try Chrome extraction (macOS).
  const chrome = extractFromChrome();
  if (chrome && chrome.teams.length > 0) {
    const chosen =
      (workspaceUrl
        ? chrome.teams.find(
            (t) => normalizeUrl(t.url) === normalizeUrl(workspaceUrl),
          )
        : null) ?? chrome.teams[0]!;
    const auth: SlackAuth = {
      auth_type: "browser",
      xoxc_token: chosen.token,
      xoxd_cookie: chrome.cookie_d,
    };
    await upsertWorkspace({
      workspace_url: normalizeUrl(chosen.url),
      workspace_name: chosen.name,
      auth: {
        auth_type: "browser",
        xoxc_token: chosen.token,
        xoxd_cookie: chrome.cookie_d,
      },
    });
    return {
      client: new SlackApiClient(auth, {
        workspaceUrl: normalizeUrl(chosen.url),
      }),
      auth,
      workspace_url: normalizeUrl(chosen.url),
    };
  }

  throw new Error(
    'No Slack credentials available. Try "agent-slack auth import-desktop" or set SLACK_TOKEN / SLACK_COOKIE_D.',
  );
}

function normalizeUrl(u: string): string {
  const url = new URL(u);
  return `${url.protocol}//${url.host}`;
}

const program = new Command();
program
  .name("agent-slack")
  .description("Slack automation CLI for AI agents")
  .version("0.1.0");

async function downloadFilesForMessages(
  client: SlackApiClient,
  auth: SlackAuth,
  messages: Array<{ files?: any[] }>,
): Promise<Record<string, string>> {
  const downloadedPaths: Record<string, string> = {};
  const downloadsDir = await ensureDownloadsDir();

  for (const m of messages) {
    for (const f of m.files ?? []) {
      if (downloadedPaths[f.id]) continue;

      let url = f.url_private_download || f.url_private;
      if (!url) {
        try {
          const info = await client.api("files.info", { file: f.id });
          url = info.file?.url_private_download || info.file?.url_private;
        } catch {
          // ignore
        }
      }
      if (!url) continue;

      const ext = inferExt(f);
      const path = await downloadSlackFile(
        auth,
        url,
        downloadsDir,
        `${f.id}${ext ? `.${ext}` : ""}`,
      );
      downloadedPaths[f.id] = path;
    }
  }

  return downloadedPaths;
}

async function getThreadSummary(
  client: SlackApiClient,
  channelId: string,
  msg: { ts: string; thread_ts?: string; reply_count?: number },
): Promise<{ ts: string; length: number } | null> {
  const replyCount = msg.reply_count ?? 0;
  const rootTs = msg.thread_ts ?? (replyCount > 0 ? msg.ts : null);
  if (!rootTs) return null;

  // If we already have reply_count (common on root messages), use it.
  if (!msg.thread_ts && replyCount > 0) {
    return { ts: rootTs, length: 1 + replyCount };
  }

  // If we're looking at a reply, fetch just the root message to get reply_count.
  const resp = await client.api("conversations.replies", {
    channel: channelId,
    ts: rootTs,
    limit: 1,
  });
  const root = resp.messages?.[0] as any;
  const rootReplyCount =
    typeof root?.reply_count === "number" ? root.reply_count : null;
  if (rootReplyCount === null) return { ts: rootTs, length: 1 };
  return { ts: rootTs, length: 1 + rootReplyCount };
}

async function handleMsgGet(
  input: string,
  options: { maxBodyChars: string; workspace?: string; ts?: string; threadTs?: string },
): Promise<void> {
  const target = parseMsgTarget(input);
  const workspaceUrl = effectiveWorkspaceUrl(options.workspace);

  const payload = await withAutoRefresh(
    target.kind === "url" ? target.ref.workspace_url : workspaceUrl,
    async () => {
      if (target.kind === "url") {
        const ref = target.ref;
        const { client, auth } = await getClientForWorkspace(ref.workspace_url);
        const msg = await fetchMessage(client, ref);
        const thread = await getThreadSummary(client, ref.channel_id, msg);
        const downloadedPaths = await downloadFilesForMessages(client, auth, [
          msg,
        ]);
        const maxBodyChars = Number.parseInt(options.maxBodyChars, 10);
        const message = toCompactMessage(msg, { maxBodyChars }, downloadedPaths);
        return { message, thread };
      }

      const ts = options.ts?.trim();
      if (!ts) {
        throw new Error(
          'When targeting a channel, you must pass --ts "<seconds>.<micros>"',
        );
      }

      await assertWorkspaceSpecifiedForChannelNames(workspaceUrl, [
        target.channel,
      ]);

      const { client, auth, workspace_url } =
        await getClientForWorkspace(workspaceUrl);
      const channelId = await resolveChannelId(client, target.channel);
      const ref = {
        workspace_url: workspace_url ?? workspaceUrl ?? "",
        channel_id: channelId,
        message_ts: ts,
        thread_ts_hint: options.threadTs?.trim() || undefined,
        raw: input,
      };

      const msg = await fetchMessage(client, ref);
      const thread = await getThreadSummary(client, channelId, msg);
      const downloadedPaths = await downloadFilesForMessages(client, auth, [msg]);
      const maxBodyChars = Number.parseInt(options.maxBodyChars, 10);
      const message = toCompactMessage(msg, { maxBodyChars }, downloadedPaths);
      return { message, thread };
    },
  );
  console.log(JSON.stringify(pruneEmpty(payload), null, 2));
}

async function handleMsgList(
  input: string,
  options: { maxBodyChars: string; workspace?: string; ts?: string; threadTs?: string },
): Promise<void> {
  const target = parseMsgTarget(input);
  const workspaceUrl = effectiveWorkspaceUrl(options.workspace);

  const payload = await withAutoRefresh(
    target.kind === "url" ? target.ref.workspace_url : workspaceUrl,
    async () => {
      if (target.kind === "url") {
        const ref = target.ref;
        const { client, auth } = await getClientForWorkspace(ref.workspace_url);
        const msg = await fetchMessage(client, ref);
        const rootTs = msg.thread_ts ?? msg.ts;
        const threadMessages = await fetchThread(client, ref.channel_id, rootTs);
        const downloadedPaths = await downloadFilesForMessages(
          client,
          auth,
          threadMessages,
        );
        const maxBodyChars = Number.parseInt(options.maxBodyChars, 10);
        return {
          messages: threadMessages
            .map((m) => toCompactMessage(m, { maxBodyChars }, downloadedPaths))
            .map(toThreadListMessage),
        };
      }

      const { client, auth, workspace_url } =
        await getClientForWorkspace(workspaceUrl);

      await assertWorkspaceSpecifiedForChannelNames(workspaceUrl, [
        target.channel,
      ]);

      const channelId = await resolveChannelId(client, target.channel);

      const threadTs = options.threadTs?.trim();
      const ts = options.ts?.trim();
      if (!threadTs && !ts) {
        throw new Error(
          'When targeting a channel, you must pass --thread-ts "<seconds>.<micros>" (or --ts to resolve a message to its thread)',
        );
      }

      const rootTs =
        threadTs ??
        (await (async () => {
          const ref = {
            workspace_url: workspace_url ?? workspaceUrl ?? "",
            channel_id: channelId,
            message_ts: ts!,
            raw: input,
          };
          const msg = await fetchMessage(client, ref);
          return msg.thread_ts ?? msg.ts;
        })());

      const threadMessages = await fetchThread(client, channelId, rootTs);
      const downloadedPaths = await downloadFilesForMessages(
        client,
        auth,
        threadMessages,
      );
      const maxBodyChars = Number.parseInt(options.maxBodyChars, 10);
      return {
        messages: threadMessages
          .map((m) => toCompactMessage(m, { maxBodyChars }, downloadedPaths))
          .map(toThreadListMessage),
      };
    },
  );
  console.log(JSON.stringify(pruneEmpty(payload), null, 2));
}

function toThreadListMessage(m: CompactSlackMessage): Omit<
  CompactSlackMessage,
  "channel_id" | "thread_ts"
> {
  const { channel_id: _channelId, thread_ts: _threadTs, ...rest } = m;
  return rest;
}

const msgCmd = program
  .command("msg")
  .description("Read Slack messages (token-efficient JSON)");

msgCmd
  .command("get", { isDefault: true })
  .description("Fetch a single Slack message (with thread summary if any)")
  .argument("<target>", "Slack message URL, #channel, or channel ID")
  .option(
    "--workspace <url>",
    "Workspace URL (needed when using #channel/channel id and you have multiple workspaces)",
  )
  .option("--ts <ts>", "Message ts (required when using #channel/channel id)")
  .option(
    "--thread-ts <ts>",
    "Thread root ts hint (useful for thread permalinks)",
  )
  .option(
    "--max-body-chars <n>",
    "Max content characters to include (default 8000, -1 for unlimited)",
    "8000",
  )
  .action(async (slackUrl, options) => {
    try {
      await handleMsgGet(slackUrl, options);
    } catch (err: any) {
      console.error(err?.message || String(err));
      process.exitCode = 1;
    }
  });

msgCmd
  .command("list")
  .description("Fetch the full thread for a Slack message URL")
  .argument("<target>", "Slack message URL, #channel, or channel ID")
  .option(
    "--workspace <url>",
    "Workspace URL (needed when using #channel/channel id and you have multiple workspaces)",
  )
  .option(
    "--thread-ts <ts>",
    "Thread root ts (required when using #channel/channel id unless you pass --ts)",
  )
  .option("--ts <ts>", "Message ts (optional: resolve message to its thread)")
  .option(
    "--max-body-chars <n>",
    "Max content characters to include (default 8000, -1 for unlimited)",
    "8000",
  )
  .action(async (slackUrl, options) => {
    try {
      await handleMsgList(slackUrl, options);
    } catch (err: any) {
      console.error(err?.message || String(err));
      process.exitCode = 1;
    }
  });

function inferExt(file: {
  mimetype?: string;
  filetype?: string;
  name?: string;
  title?: string;
}): string | null {
  const mt = (file.mimetype || "").toLowerCase();
  const ft = (file.filetype || "").toLowerCase();

  if (mt === "image/png" || ft === "png") return "png";
  if (
    mt === "image/jpeg" ||
    mt === "image/jpg" ||
    ft === "jpg" ||
    ft === "jpeg"
  )
    return "jpg";
  if (mt === "image/webp" || ft === "webp") return "webp";
  if (mt === "image/gif" || ft === "gif") return "gif";

  if (mt === "text/plain" || ft === "text") return "txt";
  if (mt === "text/markdown" || ft === "markdown" || ft === "md") return "md";
  if (mt === "application/json" || ft === "json") return "json";

  const name = file.name || file.title || "";
  const m = name.match(/\.([A-Za-z0-9]{1,10})$/);
  return m ? m[1]!.toLowerCase() : null;
}

program
  .command("thread")
  .description("Fetch all messages in a thread for a Slack message URL")
  .argument("<slack-url>", "Slack message URL")
  .option(
    "--max-body-chars <n>",
    "Max content characters to include (default 8000, -1 for unlimited)",
    "8000",
  )
  .action(async (slackUrl, options) => {
    try {
      // Back-compat alias for `msg list`
      await handleMsgList(slackUrl, options);
    } catch (err: any) {
      console.error(err?.message || String(err));
      process.exitCode = 1;
    }
  });

program
  .command("reply")
  .description("Reply in the same thread as a Slack message URL")
  .argument("<slack-url>", "Slack message URL")
  .argument("<text>", "Message text to post")
  .action(async (slackUrl, text) => {
    try {
      const ref = parseSlackMessageUrl(slackUrl);
      const resp = await withAutoRefresh(ref.workspace_url, async () => {
        const { client } = await getClientForWorkspace(ref.workspace_url);
        const msg = await fetchMessage(client, ref);
        const threadTs = msg.thread_ts ?? msg.ts;
        return await client.api("chat.postMessage", {
          channel: ref.channel_id,
          text,
          thread_ts: threadTs,
        });
      });
      console.log(JSON.stringify(pruneEmpty(resp), null, 2));
    } catch (err: any) {
      console.error(err?.message || String(err));
      process.exitCode = 1;
    }
  });

program
  .command("react")
  .description("Add an emoji reaction to a Slack message URL")
  .argument("<slack-url>", "Slack message URL")
  .argument("<emoji>", "Emoji name like +1, eyes, white_check_mark")
  .action(async (slackUrl, emoji) => {
    try {
      const ref = parseSlackMessageUrl(slackUrl);
      const resp = await withAutoRefresh(ref.workspace_url, async () => {
        const { client } = await getClientForWorkspace(ref.workspace_url);
        return await client.api("reactions.add", {
          channel: ref.channel_id,
          timestamp: ref.message_ts,
          name: emoji,
        });
      });
      console.log(JSON.stringify(pruneEmpty(resp), null, 2));
    } catch (err: any) {
      console.error(err?.message || String(err));
      process.exitCode = 1;
    }
  });

const canvasCmd = program.command("canvas").description("Work with Slack canvases");

canvasCmd
  .command("get", { isDefault: true })
  .description("Fetch a Slack canvas and convert it to Markdown")
  .argument("<canvas>", "Slack canvas URL (…/docs/…/F…) or canvas id (F…)")
  .option(
    "--workspace <url>",
    "Workspace URL (required if passing a canvas id and you have multiple workspaces)",
  )
  .option(
    "--max-chars <n>",
    "Max markdown characters to include (default 20000, -1 for unlimited)",
    "20000",
  )
  .action(async (input, options) => {
    try {
      let workspaceUrl: string | undefined;
      let canvasId: string;

      try {
        const ref = parseSlackCanvasUrl(input);
        workspaceUrl = ref.workspace_url;
        canvasId = ref.canvas_id;
      } catch {
        const trimmed = String(input).trim();
        if (!/^F[A-Z0-9]{8,}$/.test(trimmed)) {
          throw new Error(
            `Unsupported canvas input: ${input} (expected Slack canvas URL or id like F...)`,
          );
        }
        canvasId = trimmed;
        workspaceUrl = options.workspace?.trim() || undefined;
      }

      const payload = await withAutoRefresh(workspaceUrl, async () => {
        const { client, auth, workspace_url } =
          await getClientForWorkspace(workspaceUrl);
        const maxChars = Number.parseInt(options.maxChars, 10);
        return await fetchCanvasMarkdown(
          client,
          auth,
          workspace_url ?? workspaceUrl ?? "",
          canvasId,
          { maxChars },
        );
      });

      console.log(JSON.stringify(pruneEmpty(payload), null, 2));
    } catch (err: any) {
      console.error(err?.message || String(err));
      process.exitCode = 1;
    }
  });

const searchCmd = program
  .command("search")
  .description("Search Slack messages and files (token-efficient JSON)");

function addSearchOptions(cmd: Command): Command {
  return cmd
    .option(
      "--workspace <url>",
      "Workspace URL (needed when searching across multiple workspaces)",
    )
    .option(
      "--channel <channel...>",
      "Channel filter (#name, name, or id). Repeatable.",
    )
    .option("--user <user>", "User filter (@name, name, or user id U...)")
    .option("--after <date>", "Only results after YYYY-MM-DD")
    .option("--before <date>", "Only results before YYYY-MM-DD")
    .option(
      "--content-type <type>",
      "Filter content type: any|text|image|snippet|file (default any)",
    )
    .option("--limit <n>", "Max results (default 20)", "20")
    .option(
      "--max-content-chars <n>",
      "Max message content characters (default 4000, -1 for unlimited)",
      "4000",
    );
}

async function runSearch(
  kind: "messages" | "files" | "all",
  query: string,
  options: any,
): Promise<void> {
  const workspaceUrl = effectiveWorkspaceUrl(options.workspace);
  const channels = options.channel ? (options.channel as string[]) : undefined;
  if (channels?.length) {
    await assertWorkspaceSpecifiedForChannelNames(workspaceUrl, channels);
  }

  const payload = await withAutoRefresh(workspaceUrl, async () => {
    const { client, auth, workspace_url } = await getClientForWorkspace(workspaceUrl);
    const limit = Number.parseInt(options.limit, 10);
    const maxContentChars = Number.parseInt(options.maxContentChars, 10);
    const contentType = String(options.contentType ?? "any") as any;
    const user = options.user ? String(options.user) : undefined;
    const after = options.after ? String(options.after) : undefined;
    const before = options.before ? String(options.before) : undefined;

    return await searchSlack(client, auth, {
      workspace_url: workspace_url ?? workspaceUrl,
      query,
      kind,
      channels,
      user,
      after,
      before,
      content_type: contentType,
      limit,
      max_content_chars: maxContentChars,
      download: true,
    });
  });

  console.log(JSON.stringify(pruneEmpty(payload), null, 2));
}

addSearchOptions(
  searchCmd.command("all", { isDefault: true }).description("Search messages and files"),
)
  .argument("<query>", "Search query text")
  .action(async (query, options) => {
    try {
      await runSearch("all", query, options);
    } catch (err: any) {
      console.error(err?.message || String(err));
      process.exitCode = 1;
    }
  });

addSearchOptions(searchCmd.command("messages").description("Search messages"))
  .argument("<query>", "Search query text")
  .action(async (query, options) => {
    try {
      await runSearch("messages", query, options);
    } catch (err: any) {
      console.error(err?.message || String(err));
      process.exitCode = 1;
    }
  });

addSearchOptions(searchCmd.command("files").description("Search files"))
  .argument("<query>", "Search query text")
  .action(async (query, options) => {
    try {
      await runSearch("files", query, options);
    } catch (err: any) {
      console.error(err?.message || String(err));
      process.exitCode = 1;
    }
  });

const auth = program.command("auth").description("Manage Slack authentication");

auth
  .command("status")
  .description("Show configured workspaces and token sources")
  .action(async () => {
    try {
      const creds = await loadCredentials();
      const sanitized = {
        ...creds,
        workspaces: creds.workspaces.map((w) => ({
          workspace_url: w.workspace_url,
          workspace_name: w.workspace_name,
          auth_type: w.auth.auth_type,
          token:
            w.auth.auth_type === "standard"
              ? redactSecret(w.auth.token)
              : redactSecret(w.auth.xoxc_token),
          cookie_d:
            w.auth.auth_type === "browser"
              ? redactSecret(w.auth.xoxd_cookie)
              : undefined,
        })),
      };
      console.log(JSON.stringify(pruneEmpty(sanitized), null, 2));
    } catch (err: any) {
      console.error(err?.message || String(err));
      process.exitCode = 1;
    }
  });

auth
  .command("import-chrome")
  .description(
    "Import xoxc/xoxd from a logged-in Slack tab in Google Chrome (macOS)",
  )
  .action(async () => {
    try {
      const extracted = extractFromChrome();
      if (!extracted)
        throw new Error(
          "Could not extract tokens from Chrome. Open Slack in Chrome and ensure you're logged in.",
        );

      for (const team of extracted.teams) {
        await upsertWorkspace({
          workspace_url: normalizeUrl(team.url),
          workspace_name: team.name,
          auth: {
            auth_type: "browser",
            xoxc_token: team.token,
            xoxd_cookie: extracted.cookie_d,
          },
        });
      }
      console.log(
        `Imported ${extracted.teams.length} workspace token(s) from Chrome.`,
      );
    } catch (err: any) {
      console.error(err?.message || String(err));
      process.exitCode = 1;
    }
  });

auth
  .command("parse-curl")
  .description(
    "Paste a Slack API request copied as cURL (extracts xoxc/xoxd and saves locally)",
  )
  .action(async () => {
    try {
      const input = await new Response(process.stdin).text();
      if (!input.trim()) throw new Error("Expected cURL command on stdin");
      const parsed = parseSlackCurlCommand(input);
      await upsertWorkspace({
        workspace_url: normalizeUrl(parsed.workspace_url),
        auth: {
          auth_type: "browser",
          xoxc_token: parsed.xoxc_token,
          xoxd_cookie: parsed.xoxd_cookie,
        },
      });
      console.log(`Imported tokens for ${normalizeUrl(parsed.workspace_url)}.`);
    } catch (err: any) {
      console.error(err?.message || String(err));
      process.exitCode = 1;
    }
  });

auth
  .command("import-slacktokens")
  .description(
    "Import xoxc/xoxd from Slack Desktop local storage via slacktokens.py (auto-installs python deps; may prompt for keychain access)",
  )
  .option(
    "--path <py>",
    "Path to slacktokens.py",
    "/Users/nwparker/projects/slack-inspiration/slacktokens/slacktokens.py",
  )
  .action(async (options) => {
    try {
      const pyPath = String(options.path);
      if (!existsSync(pyPath))
        throw new Error(`slacktokens.py not found at: ${pyPath}`);
      const extracted = extractViaSlackTokens(pyPath);
      if (!extracted?.cookie?.value?.startsWith("xoxd-"))
        throw new Error("slacktokens did not return a valid xoxd cookie");

      const entries = Object.entries(extracted.tokens ?? {});
      if (entries.length === 0)
        throw new Error("slacktokens did not return any workspace tokens");

      for (const [url, info] of entries) {
        if (!info?.token?.startsWith("xoxc-")) continue;
        await upsertWorkspace({
          workspace_url: normalizeUrl(url),
          workspace_name: info.name,
          auth: {
            auth_type: "browser",
            xoxc_token: info.token,
            xoxd_cookie: extracted.cookie.value,
          },
        });
      }
      console.log(
        `Imported ${entries.length} workspace token(s) via slacktokens.`,
      );
    } catch (err: any) {
      console.error(err?.message || String(err));
      process.exitCode = 1;
    }
  });

auth
  .command("import-desktop")
  .description(
    "Import xoxc token(s) + d cookie from Slack Desktop data (TypeScript; no need to quit Slack)",
  )
  .action(async () => {
    try {
      const extracted = await extractFromSlackDesktop();
      await upsertWorkspaces(
        extracted.teams.map((team) => ({
          workspace_url: normalizeUrl(team.url),
          workspace_name: team.name,
          auth: {
            auth_type: "browser",
            xoxc_token: team.token,
            xoxd_cookie: extracted.cookie_d,
          },
        })),
      );
      const payload = {
        imported: extracted.teams.length,
        source: extracted.source,
        workspaces: extracted.teams.map((t) => ({
          workspace_url: normalizeUrl(t.url),
          workspace_name: t.name,
        })),
      };
      console.log(JSON.stringify(pruneEmpty(payload), null, 2));
    } catch (err: any) {
      console.error(err?.message || String(err));
      process.exitCode = 1;
    }
  });

auth
  .command("import-desktop-py")
  .description(
    "Import Slack Desktop tokens via slacktokens.py (python fallback; may require quitting Slack)",
  )
  .option(
    "--path <py>",
    "Path to slacktokens.py",
    "/Users/nwparker/projects/slack-inspiration/slacktokens/slacktokens.py",
  )
  .action(async (options) => {
    try {
      const pyPath = String(options.path);
      if (!existsSync(pyPath))
        throw new Error(`slacktokens.py not found at: ${pyPath}`);
      const extracted = extractViaSlackTokens(pyPath);
      if (!extracted?.cookie?.value?.startsWith("xoxd-"))
        throw new Error("slacktokens did not return a valid xoxd cookie");

      const entries = Object.entries(extracted.tokens ?? {});
      if (entries.length === 0)
        throw new Error("slacktokens did not return any workspace tokens");

      for (const [url, info] of entries) {
        if (!info?.token?.startsWith("xoxc-")) continue;
        await upsertWorkspace({
          workspace_url: normalizeUrl(url),
          workspace_name: info.name,
          auth: {
            auth_type: "browser",
            xoxc_token: info.token,
            xoxd_cookie: extracted.cookie.value,
          },
        });
      }
      console.log(
        `Imported ${entries.length} workspace token(s) via slacktokens.`,
      );
    } catch (err: any) {
      console.error(err?.message || String(err));
      process.exitCode = 1;
    }
  });

auth
  .command("add")
  .description("Add credentials (standard token or browser xoxc/xoxd)")
  .requiredOption(
    "--workspace-url <url>",
    "Workspace URL like https://myteam.slack.com",
  )
  .option("--token <token>", "Standard Slack token (xoxb/xoxp)")
  .option("--xoxc <token>", "Browser token (xoxc-...)")
  .option("--xoxd <cookie>", "Browser cookie d (xoxd-...)")
  .action(async (options) => {
    try {
      const workspaceUrl = normalizeUrl(options.workspaceUrl);
      if (options.token) {
        await upsertWorkspace({
          workspace_url: workspaceUrl,
          auth: { auth_type: "standard", token: options.token },
        });
        console.log("Saved standard token.");
        return;
      }
      if (options.xoxc && options.xoxd) {
        await upsertWorkspace({
          workspace_url: workspaceUrl,
          auth: {
            auth_type: "browser",
            xoxc_token: options.xoxc,
            xoxd_cookie: options.xoxd,
          },
        });
        console.log("Saved browser tokens.");
        return;
      }
      throw new Error("Provide either --token or both --xoxc and --xoxd");
    } catch (err: any) {
      console.error(err?.message || String(err));
      process.exitCode = 1;
    }
  });

auth
  .command("set-default")
  .description("Set the default workspace URL")
  .argument("<workspace-url>", "Workspace URL like https://myteam.slack.com")
  .action(async (workspaceUrl) => {
    try {
      await setDefaultWorkspace(workspaceUrl);
      console.log("Default workspace updated.");
    } catch (err: any) {
      console.error(err?.message || String(err));
      process.exitCode = 1;
    }
  });

auth
  .command("remove")
  .description("Remove a workspace from local config")
  .argument("<workspace-url>", "Workspace URL like https://myteam.slack.com")
  .action(async (workspaceUrl) => {
    try {
      await removeWorkspace(workspaceUrl);
      console.log("Removed workspace.");
    } catch (err: any) {
      console.error(err?.message || String(err));
      process.exitCode = 1;
    }
  });

program
  .command("doctor")
  .description("Check that Slack credentials work (calls auth.test)")
  .option("--workspace-url <url>", "Workspace URL")
  .action(async (options) => {
    try {
      const resp = await withAutoRefresh(options.workspaceUrl, async () => {
        const { client } = await getClientForWorkspace(options.workspaceUrl);
        return await client.api("auth.test", {});
      });
      console.log(JSON.stringify(pruneEmpty(resp), null, 2));
    } catch (err: any) {
      console.error(err?.message || String(err));
      process.exitCode = 1;
    }
  });

program.parse(process.argv);
if (!process.argv.slice(2).length) program.outputHelp();
