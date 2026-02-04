import { CREDENTIALS_FILE, KEYCHAIN_SERVICE } from "./paths.ts";
import { readJsonFile, writeJsonFile } from "../lib/fs.ts";
import {
  CredentialsSchema,
  type Credentials,
  type Workspace,
} from "./schema.ts";
import { keychainGet, keychainSet } from "./keychain.ts";

function normalizeWorkspaceUrl(workspaceUrl: string): string {
  const u = new URL(workspaceUrl);
  return `${u.protocol}//${u.host}`;
}

export async function loadCredentials(): Promise<Credentials> {
  const fromFile = await readJsonFile<unknown>(CREDENTIALS_FILE);
  const parsed = CredentialsSchema.safeParse(
    fromFile ?? { version: 1, workspaces: [] },
  );
  if (!parsed.success) return { version: 1, workspaces: [] };

  // Optional: hydrate browser cookie/token from keychain for security.
  const creds = parsed.data;
  const hydrated = creds.workspaces.map((w) => {
    if (w.auth.auth_type !== "browser") return w;
    const xoxc = keychainGet(
      `xoxc:${normalizeWorkspaceUrl(w.workspace_url)}`,
      KEYCHAIN_SERVICE,
    );
    const xoxd = keychainGet("xoxd", KEYCHAIN_SERVICE);
    return {
      ...w,
      auth: {
        auth_type: "browser" as const,
        xoxc_token: xoxc ?? w.auth.xoxc_token,
        xoxd_cookie: xoxd ?? w.auth.xoxd_cookie,
      },
    };
  });

  return { ...creds, workspaces: hydrated };
}

export async function saveCredentials(credentials: Credentials): Promise<void> {
  const payload: Credentials = {
    ...credentials,
    updated_at: new Date().toISOString(),
    workspaces: credentials.workspaces.map((w) => ({
      ...w,
      workspace_url: normalizeWorkspaceUrl(w.workspace_url),
    })),
  };

  // Store secrets in keychain when possible; keep redacted-ish copies in file.
  const firstBrowser = payload.workspaces.find(
    (w) => w.auth.auth_type === "browser",
  );
  if (firstBrowser?.auth.auth_type === "browser") {
    const existing = keychainGet("xoxd", KEYCHAIN_SERVICE);
    if (existing !== firstBrowser.auth.xoxd_cookie) {
      keychainSet("xoxd", firstBrowser.auth.xoxd_cookie, KEYCHAIN_SERVICE);
    }
  }
  for (const w of payload.workspaces) {
    if (w.auth.auth_type !== "browser") continue;
    const account = `xoxc:${normalizeWorkspaceUrl(w.workspace_url)}`;
    const existing = keychainGet(account, KEYCHAIN_SERVICE);
    if (existing !== w.auth.xoxc_token) {
      keychainSet(account, w.auth.xoxc_token, KEYCHAIN_SERVICE);
    }
  }

  await writeJsonFile(CREDENTIALS_FILE, payload);
}

export async function upsertWorkspace(
  workspace: Workspace,
): Promise<Workspace> {
  const creds = await loadCredentials();
  const normalizedUrl = normalizeWorkspaceUrl(workspace.workspace_url);
  const next: Workspace = { ...workspace, workspace_url: normalizedUrl };

  const idx = creds.workspaces.findIndex(
    (w) => normalizeWorkspaceUrl(w.workspace_url) === normalizedUrl,
  );
  if (idx === -1) {
    creds.workspaces.push(next);
  } else {
    creds.workspaces[idx] = {
      ...creds.workspaces[idx],
      ...next,
      auth: next.auth,
    };
  }

  if (!creds.default_workspace_url) creds.default_workspace_url = normalizedUrl;
  await saveCredentials(creds);
  return next;
}

export async function upsertWorkspaces(workspaces: Workspace[]): Promise<void> {
  if (workspaces.length === 0) return;
  const creds = await loadCredentials();

  for (const workspace of workspaces) {
    const normalizedUrl = normalizeWorkspaceUrl(workspace.workspace_url);
    const next: Workspace = { ...workspace, workspace_url: normalizedUrl };

    const idx = creds.workspaces.findIndex(
      (w) => normalizeWorkspaceUrl(w.workspace_url) === normalizedUrl,
    );
    if (idx === -1) {
      creds.workspaces.push(next);
    } else {
      creds.workspaces[idx] = {
        ...creds.workspaces[idx],
        ...next,
        auth: next.auth,
      };
    }

    if (!creds.default_workspace_url)
      creds.default_workspace_url = normalizedUrl;
  }

  await saveCredentials(creds);
}

export async function setDefaultWorkspace(workspaceUrl: string): Promise<void> {
  const creds = await loadCredentials();
  creds.default_workspace_url = normalizeWorkspaceUrl(workspaceUrl);
  await saveCredentials(creds);
}

export async function removeWorkspace(workspaceUrl: string): Promise<void> {
  const creds = await loadCredentials();
  const normalized = normalizeWorkspaceUrl(workspaceUrl);
  creds.workspaces = creds.workspaces.filter(
    (w) => normalizeWorkspaceUrl(w.workspace_url) !== normalized,
  );
  if (creds.default_workspace_url === normalized) {
    creds.default_workspace_url = creds.workspaces[0]?.workspace_url;
  }
  await saveCredentials(creds);
}

export async function resolveWorkspaceForUrl(
  workspaceUrl: string,
): Promise<Workspace | null> {
  const creds = await loadCredentials();
  const normalized = normalizeWorkspaceUrl(workspaceUrl);
  return (
    creds.workspaces.find(
      (w) => normalizeWorkspaceUrl(w.workspace_url) === normalized,
    ) ?? null
  );
}

export async function resolveDefaultWorkspace(): Promise<Workspace | null> {
  const creds = await loadCredentials();
  if (creds.default_workspace_url) {
    const byDefault = creds.workspaces.find(
      (w) => w.workspace_url === creds.default_workspace_url,
    );
    if (byDefault) return byDefault;
  }
  return creds.workspaces[0] ?? null;
}
