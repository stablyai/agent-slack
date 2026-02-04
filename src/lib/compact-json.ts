export function pruneEmpty<T>(value: T): T {
  const pruned = pruneEmptyInternal(value);
  return (pruned === undefined ? ({} as T) : (pruned as T)) as T;
}

function pruneEmptyInternal(value: unknown): unknown {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    return value.trim() === "" ? undefined : value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    const next = value
      .map((v) => pruneEmptyInternal(v))
      .filter((v): v is Exclude<unknown, undefined> => v !== undefined);
    return next.length === 0 ? undefined : next;
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const next = pruneEmptyInternal(v);
      if (next !== undefined) {
        out[k] = next;
      }
    }
    return Object.keys(out).length === 0 ? undefined : out;
  }

  return value;
}
