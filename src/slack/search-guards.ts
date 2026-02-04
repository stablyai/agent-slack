export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function getNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
