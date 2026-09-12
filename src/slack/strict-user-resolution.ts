import { isRecord } from "../lib/object-type-guards.ts";
import type { SlackApiClient } from "./client.ts";
import { isUserId } from "./user-id.ts";

type Identity =
  | { kind: "id"; value: string; key: string }
  | { kind: "email"; value: string; key: string };

type ResolutionResult = {
  index: number;
  status: "resolved" | "unresolved";
  mention?: `<@${string}>`;
};

type InternalResult = ResolutionResult & { userId?: string };

export type UserResolution = {
  safe_to_mention: boolean;
  results: ResolutionResult[];
};

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const MAX_USER_RESOLUTION_IDENTITIES = 20;

export function validateStrictUserIdentityBatch(identities: string[]): void {
  prepareIdentities(identities);
}

export async function resolveStrictUserIdentities(input: {
  client: SlackApiClient;
  identities: string[];
  edgeCacheId?: string;
}): Promise<UserResolution> {
  const identities = prepareIdentities(input.identities);
  const uniqueIdentities = new Map<string, Identity>();
  for (const identity of identities) {
    uniqueIdentities.set(identity.key, identity);
  }
  const resultByIdentity = new Map<string, Omit<InternalResult, "index">>();

  for (const identity of uniqueIdentities.values()) {
    let response: Record<string, unknown>;
    try {
      response =
        identity.kind === "id"
          ? await input.client.api("users.info", { user: identity.value })
          : await input.client.lookupUserByEmail(identity.value, input.edgeCacheId);
    } catch (error) {
      if (isNotFoundError(error, identity.kind)) {
        resultByIdentity.set(identity.key, { status: "unresolved" });
        continue;
      }
      throw error;
    }

    let userId: string | null;
    if (identity.kind === "email" && Array.isArray(response.results)) {
      const candidates = parseExactEmailCandidates(response.results, identity.value);
      if (candidates.length !== 1) {
        resultByIdentity.set(identity.key, { status: "unresolved" });
        continue;
      }
      const verified = await input.client.api("users.info", { user: candidates[0] });
      userId = parseVerifiedUserId(verified.user);
    } else {
      userId = parseVerifiedUserId(response.user);
    }
    if (typeof userId === "string" && (identity.kind === "email" || userId === identity.value)) {
      resultByIdentity.set(identity.key, { status: "resolved", userId });
    } else {
      resultByIdentity.set(identity.key, { status: "unresolved" });
    }
  }

  const results = identities.map((identity, index): InternalResult => {
    const result = resultByIdentity.get(identity.key);
    if (!result) {
      throw new Error("User identity resolution result is missing");
    }
    return { index, ...result };
  });

  if (results.every((result) => result.status === "resolved")) {
    return {
      safe_to_mention: true,
      results: results.map((result) => ({
        index: result.index,
        status: "resolved",
        mention: `<@${result.userId!}>`,
      })),
    };
  }

  return {
    safe_to_mention: false,
    results: results.map(({ index, status }) => ({ index, status })),
  };
}

function prepareIdentities(inputs: string[]): Identity[] {
  if (inputs.length === 0) {
    throw new Error("At least one user identity is required");
  }
  if (inputs.length > MAX_USER_RESOLUTION_IDENTITIES) {
    throw new Error(
      `At most ${MAX_USER_RESOLUTION_IDENTITIES} user identities may be resolved at once`,
    );
  }
  return inputs.map(parseIdentity);
}

function parseIdentity(input: string, index: number): Identity {
  const value = input.trim();
  if (isUserId(value)) {
    return { kind: "id", value, key: `id:${value}` };
  }
  if (EMAIL_PATTERN.test(value)) {
    const email = value.toLowerCase();
    return { kind: "email", value: email, key: `email:${email}` };
  }
  throw new Error(`User identity at index ${index} must be a canonical U/W ID or email`);
}

function parseVerifiedUserId(value: unknown): string | null {
  if (!isRecord(value) || Array.isArray(value)) {
    return null;
  }
  const id = typeof value.id === "string" && isUserId(value.id) ? value.id : null;
  const profile = isRecord(value.profile) && !Array.isArray(value.profile) ? value.profile : null;
  if (!id || id === "USLACKBOT" || !profile || value.deleted !== false || value.is_bot !== false) {
    return null;
  }

  const inactiveOrBotSignals = [
    value.is_connector_bot,
    value.is_workflow_bot,
    value.is_agentforce_bot,
    value.is_invited_user,
    value.suspended,
    value.is_forgotten,
    value.is_profile_only_user,
    profile.is_agentforce_bot,
    profile.is_sidekick_bot,
  ];
  if (inactiveOrBotSignals.some((signal) => signal != null && signal !== false)) {
    return null;
  }
  if (profile.bot_id != null && profile.bot_id !== "") {
    return null;
  }

  return id;
}

function parseExactEmailCandidates(results: unknown[], email: string): string[] {
  const candidates = new Set<string>();
  for (const result of results) {
    if (!isRecord(result) || Array.isArray(result)) {
      throw new Error("Slack users/search returned a malformed result");
    }
    const profile =
      isRecord(result.profile) && !Array.isArray(result.profile) ? result.profile : null;
    const resultEmail =
      profile && typeof profile.email === "string" ? profile.email.trim().toLowerCase() : undefined;
    if (resultEmail !== email) {
      continue;
    }
    const id = typeof result.id === "string" && isUserId(result.id) ? result.id : null;
    if (!id) {
      throw new Error("Slack users/search returned an exact email match without a valid user ID");
    }
    candidates.add(id);
  }
  return [...candidates];
}

function isNotFoundError(error: unknown, kind: Identity["kind"]): boolean {
  const expected = kind === "id" ? "user_not_found" : "users_not_found";
  if (error instanceof Error && error.message === expected) {
    return true;
  }
  if (!isRecord(error) || !isRecord(error.data) || Array.isArray(error.data)) {
    return false;
  }
  return error.data.error === expected;
}
