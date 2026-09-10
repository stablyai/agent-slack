export const SLACK_WORKSPACE_ORIGIN_ERROR =
  "Workspace URL must be a canonical HTTPS Slack workspace origin " +
  "(https://<workspace>.slack.com).";

function isSlackWorkspaceHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  const suffix = ".slack.com";
  if (!normalized.endsWith(suffix) || normalized.length > 253) {
    return false;
  }

  const workspace = normalized.slice(0, -suffix.length);
  return (
    workspace.length > 0 &&
    workspace.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  );
}

export function normalizeSlackWorkspaceUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(SLACK_WORKSPACE_ORIGIN_ERROR);
  }

  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search !== "" ||
    url.hash !== "" ||
    !isSlackWorkspaceHostname(url.hostname)
  ) {
    throw new Error(SLACK_WORKSPACE_ORIGIN_ERROR);
  }

  return url.origin;
}
