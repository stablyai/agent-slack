/**
 * Shared CLI option helpers for repeatable file-attachment flags. Kept here so
 * `message send`, `message draft create`, and `message draft update` share one
 * reducer and one path-normalization routine instead of three private copies.
 */

/** Commander reducer for a repeatable string option (e.g. `--attach`). */
export function collectOptionValue(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/** Trim and de-duplicate repeatable `--attach` paths (order preserved). */
export function normalizeAttachPaths(raw: string[] | undefined): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [];
  }
  const out: string[] = [];
  for (const p of raw.map((v) => String(v).trim()).filter(Boolean)) {
    if (!out.includes(p)) {
      out.push(p);
    }
  }
  return out;
}
