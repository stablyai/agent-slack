export function pruneEmpty<T>(value: T): T {
  const pruned = pruneEmptyInternal(value);
  return (pruned === undefined ? ({} as any) : pruned) as T;
}

function pruneEmptyInternal(value: any): any {
  if (value === null || value === undefined) return undefined;

  if (typeof value === "string") {
    return value.trim() === "" ? undefined : value;
  }

  if (typeof value === "number" || typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    const next = value
      .map((v) => pruneEmptyInternal(v))
      .filter((v) => v !== undefined);
    return next.length === 0 ? undefined : next;
  }

  if (typeof value === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      const next = pruneEmptyInternal(v);
      if (next !== undefined) out[k] = next;
    }
    return Object.keys(out).length === 0 ? undefined : out;
  }

  return value;
}
