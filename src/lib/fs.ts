import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch (err: unknown) {
    if (isRecord(err) && err.code === "ENOENT") {
      return null;
    }
    // Corrupted JSON should not brick the CLI; treat as missing.
    if (err instanceof SyntaxError) {
      return null;
    }
    throw err;
  }
}

export async function writeJsonFile(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
