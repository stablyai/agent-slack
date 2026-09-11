import { getString, isRecord } from "../lib/object-type-guards.ts";
import type { SlackApiClient, SlackAuth } from "../slack/client.ts";
import { isUserId } from "../slack/user-id.ts";
import type { CliContext } from "./context.ts";

const TEAM_ID_PATTERN = /^T[A-Z0-9]{8,19}$/;
const ENTERPRISE_ID_PATTERN = /^E[A-Z0-9]{8,19}$/;

export type SlackNativeDraftEndpoint = {
  client: SlackApiClient;
  auth: SlackAuth;
  workspaceUrl?: string;
};

/**
 * Slack routes drafts.* calls through the organization on Enterprise Grid.
 * Bind that organization credential to the same enterprise and user before
 * using it for a workspace-targeted scheduled message.
 */
export async function resolveSlackNativeDraftEndpoint(input: {
  ctx: CliContext;
  client: SlackApiClient;
  auth: SlackAuth;
  workspaceUrl?: string;
}): Promise<SlackNativeDraftEndpoint> {
  if (input.auth.auth_type !== "browser" || isEnterpriseWorkspaceUrl(input.workspaceUrl)) {
    return {
      client: input.client,
      auth: input.auth,
      workspaceUrl: input.workspaceUrl,
    };
  }

  const identity = await input.client.api("auth.test", {});
  const workspaceUserId = getString(identity.user_id);
  const workspaceTeamId = getString(identity.team_id);
  if (!workspaceUserId || !isUserId(workspaceUserId)) {
    throw new Error("Slack auth.test did not return a canonical user ID for native drafts.");
  }
  if (!workspaceTeamId || !TEAM_ID_PATTERN.test(workspaceTeamId)) {
    throw new Error(
      "Slack auth.test did not return a canonical workspace team ID for native drafts.",
    );
  }
  if (input.workspaceUrl && getHttpsOrigin(identity.url) !== getHttpsOrigin(input.workspaceUrl)) {
    throw new Error(
      "Slack auth.test workspace origin does not match the selected workspace for native drafts.",
    );
  }

  const response = await input.client.api("team.info", {});
  const team = isRecord(response.team) ? response.team : null;
  if (!team || getString(team.id) !== workspaceTeamId) {
    throw new Error(
      "Slack team.info does not match the workspace verified by auth.test for native drafts.",
    );
  }
  const enterpriseId = getString(team.enterprise_id)?.trim();
  if (!enterpriseId) {
    return {
      client: input.client,
      auth: input.auth,
      workspaceUrl: input.workspaceUrl,
    };
  }
  if (!ENTERPRISE_ID_PATTERN.test(enterpriseId)) {
    throw new Error("Slack team.info returned an invalid Enterprise Grid ID for native drafts.");
  }

  const enterpriseDomain = getString(team.enterprise_domain)?.trim().toLowerCase();
  if (!enterpriseDomain || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(enterpriseDomain)) {
    throw new Error("Slack did not return a valid Enterprise Grid domain for native drafts.");
  }
  const enterpriseWorkspaceUrl = `https://${enterpriseDomain}.enterprise.slack.com`;
  let enterprise: Awaited<ReturnType<CliContext["getClientForWorkspace"]>>;
  try {
    enterprise = await input.ctx.getClientForWorkspace(enterpriseWorkspaceUrl, {
      excludeAuth: input.auth,
    });
  } catch (error) {
    throw missingOrganizationCredentialsError(enterpriseWorkspaceUrl, error);
  }
  if (
    enterprise.auth.auth_type !== "browser" ||
    enterprise.auth.xoxc_token === input.auth.xoxc_token
  ) {
    throw missingOrganizationCredentialsError(enterpriseWorkspaceUrl);
  }
  const enterpriseIdentity = await enterprise.client.api("auth.test", {});
  if (getString(enterpriseIdentity.team_id)?.trim() !== enterpriseId) {
    throw new Error(
      "The resolved Enterprise Grid credentials do not match the target workspace's organization.",
    );
  }
  if (getString(enterpriseIdentity.user_id) !== workspaceUserId) {
    throw new Error(
      "The workspace and Enterprise Grid credentials do not belong to the same Slack user.",
    );
  }
  return {
    client: enterprise.client,
    auth: enterprise.auth,
    workspaceUrl: enterprise.workspace_url ?? enterpriseWorkspaceUrl,
  };
}

function missingOrganizationCredentialsError(workspaceUrl: string, cause?: unknown): Error {
  return new Error(
    `Enterprise Grid native drafts require separate organization browser credentials for ${workspaceUrl}. Import or configure that organization workspace before scheduling, listing, or cancelling native schedules.`,
    { cause },
  );
}

function isEnterpriseWorkspaceUrl(workspaceUrl: string | undefined): boolean {
  if (!workspaceUrl) {
    return false;
  }
  try {
    return new URL(workspaceUrl).hostname.endsWith(".enterprise.slack.com");
  } catch {
    return false;
  }
}

function getHttpsOrigin(value: unknown): string | undefined {
  const raw = getString(value);
  if (!raw) {
    return undefined;
  }
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password ? url.origin : undefined;
  } catch {
    return undefined;
  }
}
