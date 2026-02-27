import { extractFromBrave } from "../auth/brave.ts";
import { extractFromChrome } from "../auth/chrome.ts";
import { parseSlackCurlCommand } from "../auth/curl.ts";
import { extractFromSlackDesktop } from "../auth/desktop.ts";
import { extractFromFirefox } from "../auth/firefox.ts";
import {
  loadCredentials,
  resolveDefaultWorkspace,
  resolveWorkspaceForUrl,
  upsertWorkspace,
  upsertWorkspaces,
} from "../auth/store.ts";
import { resolveWorkspaceSelector } from "./workspace-selector.ts";
import { normalizeChannelInput } from "../slack/channels.ts";
import { SlackApiClient, type SlackAuth } from "../slack/client.ts";

export type CliContext = {
  effectiveWorkspaceUrl: (flag?: string) => string | undefined;
  assertWorkspaceSpecifiedForChannelNames: (input: {
    workspaceUrl: string | undefined;
    channels: string[];
  }) => Promise<void>;
  withAutoRefresh: <T>(input: {
    workspaceUrl: string | undefined;
    work: () => Promise<T>;
  }) => Promise<T>;
  getClientForWorkspace: (workspaceUrl?: string) => Promise<{
    client: SlackApiClient;
    auth: SlackAuth;
    workspace_url?: string;
  }>;
  normalizeUrl: (u: string) => string;
  errorMessage: (err: unknown) => string;
  parseContentType: (value: unknown) => "any" | "text" | "image" | "snippet" | "file";
  parseCurl: (curl: string) => ReturnType<typeof parseSlackCurlCommand>;
  importDesktop: () => ReturnType<typeof extractFromSlackDesktop>;
  importChrome: () => ReturnType<typeof extractFromChrome>;
  importBrave: () => ReturnType<typeof extractFromBrave>;
  importFirefox: () => ReturnType<typeof extractFromFirefox>;
};

function isEnvAuthConfigured(): boolean {
  return Boolean(process.env.SLACK_TOKEN?.trim());
}

function effectiveWorkspaceUrl(flag?: string): string | undefined {
  return flag?.trim() || process.env.SLACK_WORKSPACE_URL?.trim() || undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseContentType(value: unknown): "any" | "text" | "image" | "snippet" | "file" {
  const raw = String(value ?? "any").toLowerCase();
  if (raw === "text" || raw === "image" || raw === "snippet" || raw === "file") {
    return raw;
  }
  return "any";
}

async function assertWorkspaceSpecifiedForChannelNames(input: {
  workspaceUrl: string | undefined;
  channels: string[];
}): Promise<void> {
  const hasName = input.channels.some((c) => normalizeChannelInput(c).kind === "name");
  if (!hasName) {
    return;
  }

  const creds = await loadCredentials();
  if ((creds.workspaces?.length ?? 0) <= 1) {
    return;
  }

  if (!input.workspaceUrl) {
    throw new Error(
      'Ambiguous channel name across multiple workspaces. Pass --workspace "<url-or-unique-substring>" (or set SLACK_WORKSPACE_URL).',
    );
  }
}

function isAuthErrorMessage(message: string): boolean {
  return /(?:^|[^a-z])(invalid_auth|token_expired)(?:$|[^a-z])/i.test(message);
}

function normalizeUrl(u: string): string {
  const url = new URL(u);
  return `${url.protocol}//${url.host}`;
}

function tryNormalizeUrl(u: string): string | undefined {
  try {
    return normalizeUrl(u);
  } catch {
    return undefined;
  }
}

async function refreshFromDesktopIfPossible(): Promise<boolean> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return false;
  }
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
    return true;
  } catch {
    return false;
  }
}

async function withAutoRefresh<T>(input: {
  workspaceUrl: string | undefined;
  work: () => Promise<T>;
}): Promise<T> {
  try {
    return await input.work();
  } catch (err: unknown) {
    const message = errorMessage(err);
    if (isEnvAuthConfigured()) {
      throw err;
    }
    if (!isAuthErrorMessage(message)) {
      throw err;
    }

    const refreshed = await refreshFromDesktopIfPossible();
    if (!refreshed) {
      throw err;
    }
    return await input.work();
  }
}

function pickAuthFromEnv(): SlackAuth | null {
  const token = process.env.SLACK_TOKEN?.trim();
  if (!token) {
    return null;
  }
  if (token.startsWith("xoxc-")) {
    const cookie = (process.env.SLACK_COOKIE_D || process.env.SLACK_COOKIE || "").trim();
    if (!cookie) {
      throw new Error("SLACK_TOKEN looks like xoxc- but SLACK_COOKIE_D is missing");
    }
    return { auth_type: "browser", xoxc_token: token, xoxd_cookie: cookie };
  }
  return { auth_type: "standard", token };
}

async function getClientForWorkspace(workspaceUrl?: string): Promise<{
  client: SlackApiClient;
  auth: SlackAuth;
  workspace_url?: string;
}> {
  const selector = workspaceUrl?.trim() || undefined;
  const normalizedSelectorUrl = selector ? tryNormalizeUrl(selector) : undefined;
  const selectorProvided = Boolean(selector);
  let resolvedWorkspaceUrl = normalizedSelectorUrl;
  if (selector) {
    const creds = await loadCredentials();
    const resolved = resolveWorkspaceSelector(creds.workspaces, selector);
    if (resolved.ambiguous.length > 0) {
      const options = resolved.ambiguous.map((w) => w.workspace_url).join(", ");
      throw new Error(
        `Workspace selector "${selector}" is ambiguous. Matches: ${options}. Pass a more specific selector or full workspace URL.`,
      );
    }
    if (resolved.match) {
      resolvedWorkspaceUrl = resolved.match.workspace_url;
    } else if (!normalizedSelectorUrl) {
      resolvedWorkspaceUrl = undefined;
    }
  }

  const env = pickAuthFromEnv();
  if (env) {
    const envWorkspaceUrl = process.env.SLACK_WORKSPACE_URL?.trim();
    const urlForBrowser = resolvedWorkspaceUrl || envWorkspaceUrl;
    return {
      client: new SlackApiClient(env, { workspaceUrl: urlForBrowser }),
      auth: env,
      workspace_url: urlForBrowser,
    };
  }

  if (resolvedWorkspaceUrl) {
    const ws = await resolveWorkspaceForUrl(resolvedWorkspaceUrl);
    if (ws) {
      return {
        client: new SlackApiClient(ws.auth as SlackAuth, {
          workspaceUrl: ws.workspace_url,
        }),
        auth: ws.auth as SlackAuth,
        workspace_url: ws.workspace_url,
      };
    }
  }

  if (!selectorProvided) {
    const def = await resolveDefaultWorkspace();
    if (def) {
      return {
        client: new SlackApiClient(def.auth as SlackAuth, {
          workspaceUrl: def.workspace_url,
        }),
        auth: def.auth as SlackAuth,
        workspace_url: def.workspace_url,
      };
    }
  }

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

    const desired = resolvedWorkspaceUrl
      ? await resolveWorkspaceForUrl(resolvedWorkspaceUrl)
      : selector
        ? resolveWorkspaceSelector((await loadCredentials()).workspaces, selector).match
        : await resolveDefaultWorkspace();
    const chosen = desired ?? (!selectorProvided ? await resolveDefaultWorkspace() : null);
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

  // Fallback: try Chrome or Brave extraction (macOS).
  const chrome = extractFromChrome() ?? (await extractFromBrave());
  if (chrome && chrome.teams.length > 0) {
    let chosen = chrome.teams[0]!;
    if (selector) {
      const normalizedSelector = selector.toLowerCase();
      const matches = chrome.teams.filter((t) => {
        const normalizedUrl = normalizeUrl(t.url).toLowerCase();
        const host = new URL(t.url).host.toLowerCase();
        const hostWithoutSlackSuffix = host.replace(/\.slack\.com$/i, "");
        const name = t.name?.toLowerCase() ?? "";
        return (
          normalizedUrl.includes(normalizedSelector) ||
          host.includes(normalizedSelector) ||
          hostWithoutSlackSuffix.includes(normalizedSelector) ||
          name.includes(normalizedSelector)
        );
      });
      if (matches.length > 1) {
        throw new Error(
          `Workspace selector "${selector}" is ambiguous in Chrome workspaces. Matches: ${matches.map((t) => normalizeUrl(t.url)).join(", ")}. Pass a more specific selector or full workspace URL.`,
        );
      }
      if (matches.length === 1) {
        chosen = matches[0]!;
      } else if (normalizedSelectorUrl) {
        try {
          chosen =
            chrome.teams.find((t) => normalizeUrl(t.url) === normalizeUrl(selector)) ?? chosen;
        } catch {
          // Keep default selection.
        }
      } else {
        throw new Error(
          `No configured workspace matches selector "${selector}". Run "agent-slack auth whoami" to list available workspaces.`,
        );
      }
    }
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

  const firefox = await extractFromFirefox();
  if (firefox && firefox.teams.length > 0) {
    let chosen = firefox.teams[0]!;
    if (selector) {
      const normalizedSelector = selector.toLowerCase();
      const matches = firefox.teams.filter((t) => {
        const normalizedUrl = normalizeUrl(t.url).toLowerCase();
        const host = new URL(t.url).host.toLowerCase();
        const hostWithoutSlackSuffix = host.replace(/\.slack\.com$/i, "");
        const name = t.name?.toLowerCase() ?? "";
        return (
          normalizedUrl.includes(normalizedSelector) ||
          host.includes(normalizedSelector) ||
          hostWithoutSlackSuffix.includes(normalizedSelector) ||
          name.includes(normalizedSelector)
        );
      });
      if (matches.length > 1) {
        throw new Error(
          `Workspace selector "${selector}" is ambiguous in Firefox workspaces. Matches: ${matches.map((t) => normalizeUrl(t.url)).join(", ")}. Pass a more specific selector or full workspace URL.`,
        );
      }
      if (matches.length === 1) {
        chosen = matches[0]!;
      } else if (normalizedSelectorUrl) {
        try {
          chosen =
            firefox.teams.find((t) => normalizeUrl(t.url) === normalizeUrl(selector)) ?? chosen;
        } catch {}
      } else {
        throw new Error(
          `No configured workspace matches selector "${selector}". Run "agent-slack auth whoami" to list available workspaces.`,
        );
      }
    }
    const auth: SlackAuth = {
      auth_type: "browser",
      xoxc_token: chosen.token,
      xoxd_cookie: firefox.cookie_d,
    };
    await upsertWorkspace({
      workspace_url: normalizeUrl(chosen.url),
      workspace_name: chosen.name,
      auth: {
        auth_type: "browser",
        xoxc_token: chosen.token,
        xoxd_cookie: firefox.cookie_d,
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

  if (selector && !normalizedSelectorUrl) {
    throw new Error(
      `No configured workspace matches selector "${selector}". Run "agent-slack auth whoami" to list available workspaces.`,
    );
  }

  throw new Error(
    'No Slack credentials available. Try "agent-slack auth import-desktop", "agent-slack auth import-chrome", "agent-slack auth import-brave", "agent-slack auth import-firefox", or set SLACK_TOKEN / SLACK_COOKIE_D.',
  );
}

export function createCliContext(): CliContext {
  return {
    effectiveWorkspaceUrl,
    assertWorkspaceSpecifiedForChannelNames,
    withAutoRefresh,
    getClientForWorkspace,
    normalizeUrl,
    errorMessage,
    parseContentType,
    parseCurl: parseSlackCurlCommand,
    importDesktop: extractFromSlackDesktop,
    importChrome: extractFromChrome,
    importBrave: extractFromBrave,
    importFirefox: extractFromFirefox,
  };
}
