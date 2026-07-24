import { isRecord } from "../lib/object-type-guards.ts";
import { isUserId } from "./user-id.ts";

export type IdentityField =
  | "id"
  | "name"
  | "real_name"
  | "profile_real_name"
  | "display_name"
  | "email";
type EvidenceState = boolean | "missing" | "invalid";

export type StrictUserMatchPath =
  | "input.id->slack.id"
  | "input.email->slack.profile.email"
  | "input.handle->slack.name"
  | "input.full_name->slack.real_name"
  | "input.full_name->slack.profile.real_name"
  | "input.full_name->slack.profile.display_name";

export type ParsedIdentity = {
  source: string;
  value: string;
  matches: { field: IdentityField; path: StrictUserMatchPath }[];
};

export type DirectoryUser = {
  id: string;
  fields: Record<IdentityField, string | undefined>;
  deleted: EvidenceState;
  isBot: EvidenceState;
  botSignal: EvidenceState;
};

export type CursorEvidence =
  | { kind: "done" }
  | { kind: "next"; cursor: string }
  | { kind: "invalid" };

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const INERT_LESS_THAN = "\u2039";
const INERT_AT = "\uFF20";
const INVALID_FIELD = Symbol("invalid_field");

export function parseIdentity(input: string): ParsedIdentity {
  const compact = compactWhitespace(input);
  if (!compact) {
    throw new Error("User identity is empty");
  }

  const source = makeStrictUserOutputInert(compact);
  const upper = compact.toUpperCase();
  if (isUserId(upper)) {
    return {
      source,
      value: normalize(upper),
      matches: [{ field: "id", path: "input.id->slack.id" }],
    };
  }

  if (EMAIL_PATTERN.test(compact) && !compact.startsWith("@")) {
    return {
      source,
      value: normalize(compact),
      matches: [{ field: "email", path: "input.email->slack.profile.email" }],
    };
  }

  if (compact.startsWith("@")) {
    const handle = compact.slice(1);
    if (!handle || /\s/.test(handle)) {
      throw new Error("Slack handles must be non-empty and contain no whitespace");
    }
    return {
      source,
      value: normalize(handle),
      matches: [{ field: "name", path: "input.handle->slack.name" }],
    };
  }

  if (/\s/.test(compact)) {
    return {
      source,
      value: normalize(compact),
      matches: [
        { field: "real_name", path: "input.full_name->slack.real_name" },
        {
          field: "profile_real_name",
          path: "input.full_name->slack.profile.real_name",
        },
        {
          field: "display_name",
          path: "input.full_name->slack.profile.display_name",
        },
      ],
    };
  }

  return {
    source,
    value: normalize(compact),
    matches: [{ field: "name", path: "input.handle->slack.name" }],
  };
}

export function parseDirectoryUser(raw: Record<string, unknown>): DirectoryUser | null {
  const id = typeof raw.id === "string" ? raw.id : null;
  if (!id || !isUserId(id)) {
    return null;
  }

  const rawProfile = raw.profile;
  const profile =
    rawProfile === null || rawProfile === undefined
      ? null
      : isRecord(rawProfile) && !Array.isArray(rawProfile)
        ? rawProfile
        : "invalid";

  if (profile === "invalid") {
    return null;
  }

  const name = optionalString(raw.name);
  const realName = optionalString(raw.real_name);
  const profileRealName = optionalString(profile?.real_name);
  const displayName = optionalString(profile?.display_name);
  const email = optionalString(profile?.email);
  if (
    name === INVALID_FIELD ||
    realName === INVALID_FIELD ||
    profileRealName === INVALID_FIELD ||
    displayName === INVALID_FIELD ||
    email === INVALID_FIELD
  ) {
    return null;
  }

  const botSignal = combinePositiveEvidence([
    booleanEvidence(raw.is_connector_bot),
    booleanEvidence(raw.is_workflow_bot),
    booleanEvidence(raw.is_agentforce_bot),
    profile ? booleanEvidence(profile.is_agentforce_bot) : "missing",
    profile ? stringSignalEvidence(profile.bot_id) : "missing",
  ]);

  return {
    id,
    fields: {
      id: normalize(id),
      name,
      real_name: realName,
      profile_real_name: profileRealName,
      display_name: displayName,
      email,
    },
    deleted: booleanEvidence(raw.deleted),
    isBot: booleanEvidence(raw.is_bot),
    botSignal,
  };
}

export function mergeDirectoryUser(existing: DirectoryUser, incoming: DirectoryUser): boolean {
  for (const field of Object.keys(existing.fields) as IdentityField[]) {
    const current = existing.fields[field];
    const next = incoming.fields[field];
    if (current !== undefined && next !== undefined && current !== next) {
      return false;
    }
    existing.fields[field] = current ?? next;
  }

  const deleted = mergeEvidence(existing.deleted, incoming.deleted);
  const isBot = mergeEvidence(existing.isBot, incoming.isBot);
  const botSignal = mergeEvidence(existing.botSignal, incoming.botSignal);
  if (deleted === "conflict" || isBot === "conflict" || botSignal === "conflict") {
    return false;
  }
  existing.deleted = deleted;
  existing.isBot = isBot;
  existing.botSignal = botSignal;
  return true;
}

export function userEligibility(user: DirectoryUser): "eligible" | "ineligible" | "unknown" {
  if (
    user.id === "USLACKBOT" ||
    user.deleted === true ||
    user.isBot === true ||
    user.botSignal === true
  ) {
    return "ineligible";
  }
  if (user.deleted !== false || user.isBot !== false || user.botSignal === "invalid") {
    return "unknown";
  }
  return "eligible";
}

export function parseNextCursor(metadata: unknown): CursorEvidence {
  if (metadata === undefined) {
    return { kind: "done" };
  }
  if (!isRecord(metadata) || Array.isArray(metadata)) {
    return { kind: "invalid" };
  }
  const cursor = metadata.next_cursor;
  if (cursor === undefined || cursor === "") {
    return { kind: "done" };
  }
  if (typeof cursor !== "string" || !cursor.trim() || cursor !== cursor.trim()) {
    return { kind: "invalid" };
  }
  return { kind: "next", cursor };
}

function optionalString(value: unknown): string | undefined | typeof INVALID_FIELD {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return INVALID_FIELD;
  }
  return normalize(value) || undefined;
}

function booleanEvidence(value: unknown): EvidenceState {
  if (value === null || value === undefined) {
    return "missing";
  }
  return typeof value === "boolean" ? value : "invalid";
}

function stringSignalEvidence(value: unknown): EvidenceState {
  if (value === null || value === undefined) {
    return "missing";
  }
  if (typeof value !== "string") {
    return "invalid";
  }
  return Boolean(value.trim());
}

function combinePositiveEvidence(values: EvidenceState[]): EvidenceState {
  if (values.includes(true)) {
    return true;
  }
  if (values.includes("invalid")) {
    return "invalid";
  }
  if (values.includes(false)) {
    return false;
  }
  return "missing";
}

function mergeEvidence(current: EvidenceState, next: EvidenceState): EvidenceState | "conflict" {
  if (current === "invalid" || next === "invalid") {
    return "invalid";
  }
  if (current === "missing") {
    return next;
  }
  if (next === "missing") {
    return current;
  }
  return current === next ? current : "conflict";
}

function compactWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalize(value: string): string {
  return compactWhitespace(value).toLowerCase();
}

export function makeStrictUserOutputInert(value: string): string {
  return value
    .replaceAll("<", INERT_LESS_THAN)
    .replace(/@(?=(?:[UWB][A-Z0-9]{6,}|here|channel|everyone)\b)/gi, INERT_AT);
}
