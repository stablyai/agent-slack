import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { getAppDir } from "./app-dir.ts";

export function getDownloadsDir(): string {
  return resolve(join(getAppDir(), "tmp", "downloads"));
}

export async function ensureDownloadsDir(): Promise<string> {
  const dir = getDownloadsDir();
  await mkdir(dir, { recursive: true });
  return dir;
}
