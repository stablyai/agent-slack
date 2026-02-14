import type { Workspace } from "../auth/schema.ts";

export type WorkspaceSelectorResult = {
  match: Workspace | null;
  ambiguous: Workspace[];
};

function normalizeUrl(u: string): string {
  const url = new URL(u);
  return `${url.protocol}//${url.host}`;
}

function normalizedWorkspaceCandidates(workspace: Workspace): string[] {
  let host = "";
  try {
    host = new URL(workspace.workspace_url).host.toLowerCase();
  } catch {
    host = "";
  }
  const hostWithoutSlackSuffix = host.replace(/\.slack\.com$/i, "");
  return [
    workspace.workspace_url.toLowerCase(),
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

  try {
    const normalized = normalizeUrl(raw).toLowerCase();
    const exact = workspaces.find((w) => w.workspace_url.toLowerCase() === normalized);
    if (exact) {
      return { match: exact, ambiguous: [] };
    }
  } catch {
    // Not a URL selector; continue with fuzzy matching.
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
