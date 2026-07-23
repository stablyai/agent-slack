export const SLACK_WORKSPACE_ORIGIN_ERROR =
  "Workspace URL must be a canonical HTTPS Slack or GovSlack origin " +
  "(https://<workspace>.slack.com or https://<workspace>.slack-gov.com).";

export type SlackRealm = "commercial" | "gov";

function parseSlackOwnedUrl(input: string | URL): URL {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input.toString()) : new URL(input);
  } catch {
    throw new Error(SLACK_WORKSPACE_ORIGIN_ERROR);
  }

  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    !isSlackWorkspaceHostname(url.hostname)
  ) {
    throw new Error(SLACK_WORKSPACE_ORIGIN_ERROR);
  }

  return url;
}

export function isSlackWorkspaceHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (
    normalized.length > 253 ||
    (!normalized.endsWith(".slack.com") && !normalized.endsWith(".slack-gov.com"))
  ) {
    return false;
  }

  const labels = normalized.split(".");
  const workspaceLabels = labels.slice(0, -2);
  return (
    workspaceLabels.length > 0 &&
    workspaceLabels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  );
}

/**
 * Validate a Slack-owned URL and return its canonical workspace origin.
 *
 * This accepts paths because message, canvas, and copied API URLs carry the
 * workspace origin alongside a resource path.
 */
export function slackWorkspaceOriginFromUrl(input: string | URL): string {
  return parseSlackOwnedUrl(input).origin;
}

export function slackRealmForUrl(input: string | URL): SlackRealm {
  return parseSlackOwnedUrl(input).hostname.endsWith(".slack-gov.com") ? "gov" : "commercial";
}

/**
 * Validate an origin-only workspace URL and return its canonical form.
 */
export function normalizeSlackWorkspaceUrl(input: string): string {
  const url = parseSlackOwnedUrl(input);
  if ((url.pathname !== "" && url.pathname !== "/") || url.search !== "" || url.hash !== "") {
    throw new Error(SLACK_WORKSPACE_ORIGIN_ERROR);
  }
  return url.origin;
}

export function slackAppOriginForWorkspace(workspaceUrl: string): string {
  return slackRealmForUrl(normalizeSlackWorkspaceUrl(workspaceUrl)) === "gov"
    ? "https://app.slack-gov.com"
    : "https://app.slack.com";
}

export function slackApiUrlForWorkspace(workspaceUrl: string): string {
  return slackRealmForUrl(normalizeSlackWorkspaceUrl(workspaceUrl)) === "gov"
    ? "https://slack-gov.com/api/"
    : "https://slack.com/api/";
}
