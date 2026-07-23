import type { Workspace } from "../auth/schema.ts";
import { normalizeSlackWorkspaceUrl } from "../slack/workspace-url.ts";

export type WorkspaceSelectorResult = {
  match: Workspace | null;
  ambiguous: Workspace[];
};

function normalizedWorkspaceCandidates(workspace: Workspace): string[] {
  let workspaceUrl: string;
  let host: string;
  try {
    workspaceUrl = normalizeSlackWorkspaceUrl(workspace.workspace_url).toLowerCase();
    host = new URL(workspaceUrl).hostname;
  } catch {
    return [];
  }
  const hostWithoutSlackSuffix = host.replace(/\.slack(?:-gov)?\.com$/i, "");
  return [
    workspaceUrl,
    host,
    hostWithoutSlackSuffix,
    workspace.workspace_name?.toLowerCase() ?? "",
    workspace.team_domain?.toLowerCase() ?? "",
  ].filter(Boolean);
}

export function resolveWorkspaceSelector(
  workspaces: Workspace[],
  selector: string,
): WorkspaceSelectorResult {
  const raw = selector.trim();
  if (!raw) {
    return { match: null, ambiguous: [] };
  }

  let parsedUrl: URL | undefined;
  try {
    parsedUrl = new URL(raw);
  } catch {
    parsedUrl = undefined;
  }
  if (parsedUrl) {
    const normalized = normalizeSlackWorkspaceUrl(raw).toLowerCase();
    const exact = workspaces.find((w) => {
      try {
        return normalizeSlackWorkspaceUrl(w.workspace_url).toLowerCase() === normalized;
      } catch {
        return false;
      }
    });
    if (exact) {
      return { match: exact, ambiguous: [] };
    }
  }

  const needle = raw.toLowerCase();
  const matches = workspaces.filter((workspace) =>
    normalizedWorkspaceCandidates(workspace).some((candidate) => candidate.includes(needle)),
  );
  if (matches.length === 1) {
    return { match: matches[0]!, ambiguous: [] };
  }
  if (matches.length > 1) {
    return { match: null, ambiguous: matches };
  }
  return { match: null, ambiguous: [] };
}
