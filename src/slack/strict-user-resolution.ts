import { isRecord } from "../lib/object-type-guards.ts";
import type { SlackApiClient } from "./client.ts";
import {
  type DirectoryUser,
  type StrictUserMatchPath,
  mergeDirectoryUser,
  parseDirectoryUser,
  parseIdentity,
  parseNextCursor,
  userEligibility,
} from "./strict-user-resolution-evidence.ts";

export { makeStrictUserOutputInert } from "./strict-user-resolution-evidence.ts";
export type { StrictUserMatchPath } from "./strict-user-resolution-evidence.ts";

export type StrictUserResolutionReason =
  | "members_invalid"
  | "cursor_invalid"
  | "cursor_repeated"
  | "user_invalid"
  | "user_conflict"
  | "eligibility_unknown"
  | "invalid_auth"
  | "token_expired"
  | "request_timeout"
  | "rate_limited"
  | "request_failed";

type StrictResolvedEvidence = {
  source: string;
  status: "resolved";
  matched_by: StrictUserMatchPath[];
};

type StrictResolvedWithMention = StrictResolvedEvidence & {
  mention: `<@${string}>`;
};

type StrictResolvedWithoutMention = StrictResolvedEvidence & {
  mention?: never;
};

type StrictNotFound = {
  source: string;
  status: "not_found";
  candidate_count: 0;
  mention?: never;
};

type StrictAmbiguous = {
  source: string;
  status: "ambiguous";
  candidate_count: number;
  mention?: never;
};

export type StrictUserResolutionResult =
  | StrictResolvedWithMention
  | StrictResolvedWithoutMention
  | StrictNotFound
  | StrictAmbiguous;

export type StrictUserResolution =
  | {
      directory: { status: "complete"; pages: number };
      safe_to_mention: true;
      results: StrictResolvedWithMention[];
    }
  | {
      directory: { status: "complete"; pages: number };
      safe_to_mention: false;
      results: (StrictResolvedWithoutMention | StrictNotFound | StrictAmbiguous)[];
    }
  | {
      directory: {
        status: "incomplete";
        pages: number;
        reason: StrictUserResolutionReason;
      };
      safe_to_mention: false;
      results: [];
    };

type EvaluatedResult =
  | (StrictResolvedEvidence & { userId: string })
  | StrictNotFound
  | StrictAmbiguous;

export class StrictUserDirectoryRequestError extends Error {
  readonly pages: number;
  readonly reason: StrictUserResolutionReason;

  constructor(error: unknown, pages: number) {
    super(error instanceof Error ? error.message : String(error));
    this.name = "StrictUserDirectoryRequestError";
    this.pages = pages;
    this.reason = requestFailureReason(this.message);
  }
}

export async function resolveStrictUserIdentities(input: {
  client: SlackApiClient;
  identities: string[];
}): Promise<StrictUserResolution> {
  if (input.identities.length === 0) {
    throw new Error("At least one identity is required");
  }

  const identities = input.identities.map(parseIdentity);
  const users = new Map<string, DirectoryUser>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;

  for (;;) {
    let response: Record<string, unknown>;
    try {
      response = await input.client.api("users.list", {
        limit: 200,
        cursor,
      });
    } catch (error) {
      throw new StrictUserDirectoryRequestError(error, pages);
    }
    pages += 1;

    if (!Array.isArray(response.members)) {
      return incompleteStrictUserResolution({
        pages,
        reason: "members_invalid",
      });
    }

    for (const rawUser of response.members) {
      if (!isRecord(rawUser) || Array.isArray(rawUser)) {
        return incompleteStrictUserResolution({
          pages,
          reason: "members_invalid",
        });
      }
      const parsed = parseDirectoryUser(rawUser);
      if (!parsed) {
        return incompleteStrictUserResolution({
          pages,
          reason: "user_invalid",
        });
      }
      const existing = users.get(parsed.id);
      if (!existing) {
        users.set(parsed.id, parsed);
        continue;
      }
      if (!mergeDirectoryUser(existing, parsed)) {
        return incompleteStrictUserResolution({
          pages,
          reason: "user_conflict",
        });
      }
    }

    const cursorEvidence = parseNextCursor(response.response_metadata);
    if (cursorEvidence.kind === "invalid") {
      return incompleteStrictUserResolution({
        pages,
        reason: "cursor_invalid",
      });
    }
    if (cursorEvidence.kind === "done") {
      break;
    }
    const nextCursor = cursorEvidence.cursor;
    if (seenCursors.has(nextCursor)) {
      return incompleteStrictUserResolution({
        pages,
        reason: "cursor_repeated",
      });
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  const matches = identities.map(() => new Map<string, Set<StrictUserMatchPath>>());
  let eligibilityUnknown = false;

  for (const user of users.values()) {
    for (const [index, identity] of identities.entries()) {
      const matchedPaths = identity.matches
        .filter(({ field }) => user.fields[field] === identity.value)
        .map(({ path }) => path);
      if (matchedPaths.length === 0) {
        continue;
      }

      const eligibility = userEligibility(user);
      if (eligibility === "unknown") {
        eligibilityUnknown = true;
        continue;
      }
      if (eligibility === "ineligible") {
        continue;
      }

      const evidence = matches[index]!.get(user.id) ?? new Set<StrictUserMatchPath>();
      for (const path of matchedPaths) {
        evidence.add(path);
      }
      matches[index]!.set(user.id, evidence);
    }
  }

  if (eligibilityUnknown) {
    return incompleteStrictUserResolution({
      pages,
      reason: "eligibility_unknown",
    });
  }

  const evaluatedResults = identities.map((identity, index): EvaluatedResult => {
    const candidates = matches[index]!;
    if (candidates.size === 0) {
      return {
        source: identity.source,
        status: "not_found",
        candidate_count: 0,
      };
    }
    if (candidates.size > 1) {
      return {
        source: identity.source,
        status: "ambiguous",
        candidate_count: candidates.size,
      };
    }

    const [userId, evidence] = candidates.entries().next().value!;
    return {
      source: identity.source,
      status: "resolved",
      matched_by: [...evidence].sort(),
      userId,
    };
  });

  const directory = { status: "complete" as const, pages };
  const allResolved = evaluatedResults.every(
    (result): result is StrictResolvedEvidence & { userId: string } => result.status === "resolved",
  );
  if (allResolved) {
    return {
      directory,
      safe_to_mention: true,
      results: evaluatedResults.map(({ userId, ...result }) => ({
        ...result,
        mention: `<@${userId}>`,
      })),
    };
  }

  return {
    directory,
    safe_to_mention: false,
    results: evaluatedResults.map((result) => {
      if (result.status !== "resolved") {
        return result;
      }
      const { userId: _userId, ...withoutUserId } = result;
      return withoutUserId;
    }),
  };
}

export function incompleteStrictUserResolution(input: {
  pages: number;
  reason: StrictUserResolutionReason;
}): StrictUserResolution {
  return {
    directory: {
      status: "incomplete",
      pages: input.pages,
      reason: input.reason,
    },
    safe_to_mention: false,
    results: [],
  };
}

function requestFailureReason(message: string): StrictUserResolutionReason {
  if (/(?:^|[^a-z])invalid_auth(?:$|[^a-z])/i.test(message)) {
    return "invalid_auth";
  }
  if (/(?:^|[^a-z])token_expired(?:$|[^a-z])/i.test(message)) {
    return "token_expired";
  }
  if (/timed out|timeout/i.test(message)) {
    return "request_timeout";
  }
  if (/rate[-_ ]?limit(?:ed)?/i.test(message)) {
    return "rate_limited";
  }
  return "request_failed";
}
