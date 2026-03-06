import { extractFromBrave } from "../auth/brave.ts";
import { extractFromChrome } from "../auth/chrome.ts";
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
import { SlackApiClient, type SlackAuth } from "../slack/client.ts";

export function normalizeUrl(u: string): string {
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

export async function getClientForWorkspace(workspaceUrl?: string): Promise<{
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

  // Fallback: try Chrome, Brave, then Firefox extraction.
  const browserSources: {
    cookie_d: string;
    teams: { url: string; name?: string; token: string }[];
  }[] = [];
  const chromeResult = extractFromChrome();
  if (chromeResult && chromeResult.teams.length > 0) {
    browserSources.push(chromeResult);
  }
  const braveResult = await extractFromBrave();
  if (braveResult && braveResult.teams.length > 0) {
    browserSources.push(braveResult);
  }
  const firefoxResult = await extractFromFirefox();
  if (firefoxResult && firefoxResult.teams.length > 0) {
    browserSources.push(firefoxResult);
  }

  for (const source of browserSources) {
    const result = await matchAndUpsertBrowserTeam({
      teams: source.teams,
      cookieD: source.cookie_d,
      selector,
      normalizedSelectorUrl,
    });
    if (result) {
      return result;
    }
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

async function matchAndUpsertBrowserTeam(input: {
  teams: { url: string; name?: string; token: string }[];
  cookieD: string;
  selector: string | undefined;
  normalizedSelectorUrl: string | undefined;
}): Promise<{ client: SlackApiClient; auth: SlackAuth; workspace_url: string } | null> {
  const { teams, cookieD, selector, normalizedSelectorUrl } = input;
  let chosen = teams[0]!;

  if (selector) {
    const normalizedSelector = selector.toLowerCase();
    const matches = teams.filter((t) => {
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
        `Workspace selector "${selector}" is ambiguous. Matches: ${matches.map((t) => normalizeUrl(t.url)).join(", ")}. Pass a more specific selector or full workspace URL.`,
      );
    }
    if (matches.length === 1) {
      chosen = matches[0]!;
    } else if (normalizedSelectorUrl) {
      const exact = teams.find((t) => {
        try {
          return normalizeUrl(t.url) === normalizeUrl(selector);
        } catch {
          return false;
        }
      });
      if (exact) {
        chosen = exact;
      } else {
        return null;
      }
    } else {
      return null;
    }
  }

  const auth: SlackAuth = {
    auth_type: "browser",
    xoxc_token: chosen.token,
    xoxd_cookie: cookieD,
  };
  const workspaceUrl = normalizeUrl(chosen.url);
  await upsertWorkspace({
    workspace_url: workspaceUrl,
    workspace_name: chosen.name,
    auth: {
      auth_type: "browser",
      xoxc_token: chosen.token,
      xoxd_cookie: cookieD,
    },
  });
  return {
    client: new SlackApiClient(auth, { workspaceUrl }),
    auth,
    workspace_url: workspaceUrl,
  };
}
