import { isRecord } from "../lib/object-type-guards.ts";

/**
 * True when a Slack API failure is the org-level `team_is_restricted` denial.
 * Browser auth throws that string as `Error.message`; `@slack/web-api` puts it
 * on `error.data.error` and wraps it as `An API error occurred: …`.
 */
export function isTeamRestrictedError(err: unknown): boolean {
  const texts: string[] = [];
  collectErrorText({ value: err, out: texts, depth: 0 });
  return texts.some((text) => text === "team_is_restricted" || text.includes("team_is_restricted"));
}

function collectErrorText(input: { value: unknown; out: string[]; depth: number }): void {
  const { value, out, depth } = input;
  if (depth > 4 || value == null) {
    return;
  }
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (value instanceof Error) {
    out.push(value.message);
    const extra = value as Error & { data?: unknown; code?: unknown };
    if (typeof extra.code === "string") {
      out.push(extra.code);
    }
    collectErrorText({ value: extra.data, out, depth: depth + 1 });
    collectErrorText({ value: value.cause, out, depth: depth + 1 });
    return;
  }
  if (isRecord(value)) {
    if (typeof value.error === "string") {
      out.push(value.error);
    }
    if (typeof value.message === "string") {
      out.push(value.message);
    }
    collectErrorText({ value: value.data, out, depth: depth + 1 });
  }
}
