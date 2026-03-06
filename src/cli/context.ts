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
import type { SlackApiClient } from "../slack/client.ts";
import { type SlackAuth } from "../slack/client.ts";
import { getClientForWorkspace, normalizeUrl } from "./context-client-resolver.ts";

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
