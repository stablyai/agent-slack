import { copyFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export type SqliteRow = Record<string, unknown>;

export type ProfileCandidate = {
  name?: string;
  path: string;
  isDefault: boolean;
};

const PLATFORM = platform();
const IS_MACOS = PLATFORM === "darwin";
const IS_LINUX = PLATFORM === "linux";

export function isMissingBunSqliteModule(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const err = error as { code?: unknown; message?: unknown };
  const code = typeof err.code === "string" ? err.code : "";
  const message = typeof err.message === "string" ? err.message : "";

  if (code === "ERR_MODULE_NOT_FOUND" || code === "ERR_UNSUPPORTED_ESM_URL_SCHEME") {
    return true;
  }
  if (!message.includes("bun:sqlite")) {
    return false;
  }
  return (
    message.includes("Cannot find module") ||
    message.includes("Unknown builtin module") ||
    message.includes("unsupported URL scheme") ||
    message.includes("Only URLs with a scheme in")
  );
}

export async function queryReadonlySqlite(dbPath: string, sql: string): Promise<SqliteRow[]> {
  try {
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath, { readonly: true });
    try {
      return db.query(sql).all() as SqliteRow[];
    } finally {
      db.close();
    }
  } catch (error) {
    if (!isMissingBunSqliteModule(error)) {
      throw error;
    }
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return db.prepare(sql).all() as SqliteRow[];
    } finally {
      db.close();
    }
  }
}

export function getFirefoxBaseDir(): string {
  if (IS_LINUX) {
    return join(homedir(), ".mozilla", "firefox");
  }
  if (IS_MACOS) {
    return join(homedir(), "Library", "Application Support", "Firefox");
  }
  throw new Error(`Firefox extraction is not supported on ${PLATFORM}.`);
}

export function parseProfilesIni(raw: string, baseDir: string): ProfileCandidate[] {
  const lines = raw.split(/\r?\n/);
  const profiles: {
    name?: string;
    path?: string;
    isRelative: boolean;
    isDefault: boolean;
  }[] = [];
  // Firefox can mark defaults either in [Profile*] (Default=1) or [Install*] sections.
  const installDefaults = new Set<string>();

  let section = "";
  let current: { name?: string; path?: string; isRelative: boolean; isDefault: boolean } | null =
    null;

  for (const lineRaw of lines) {
    const line = lineRaw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      if (current) {
        profiles.push(current);
        current = null;
      }
      section = line.slice(1, -1);
      if (section.startsWith("Profile")) {
        current = { isRelative: true, isDefault: false };
      }
      continue;
    }

    const idx = line.indexOf("=");
    if (idx === -1) {
      continue;
    }
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();

    if (section.startsWith("Profile") && current) {
      if (key === "Name") {
        current.name = value;
      } else if (key === "Path") {
        current.path = value;
      } else if (key === "IsRelative") {
        current.isRelative = value !== "0";
      } else if (key === "Default") {
        current.isDefault = value === "1";
      }
      continue;
    }

    if (section.startsWith("Install") && key === "Default" && value) {
      installDefaults.add(value);
    }
  }

  if (current) {
    profiles.push(current);
  }

  return profiles
    .filter((p) => Boolean(p.path))
    .map((p) => {
      const profilePath = p.isRelative ? join(baseDir, p.path!) : p.path!;
      return {
        name: p.name,
        path: profilePath,
        isDefault: p.isDefault || installDefaults.has(p.path!),
      };
    });
}

export async function listProfileCandidates(): Promise<ProfileCandidate[]> {
  const baseDir = getFirefoxBaseDir();
  const iniPath = join(baseDir, "profiles.ini");
  const candidates: ProfileCandidate[] = [];

  if (existsSync(iniPath)) {
    const raw = await readFile(iniPath, "utf8");
    candidates.push(...parseProfilesIni(raw, baseDir));
  }

  // profiles.ini can be stale, so also scan profile directories as a fallback source.
  const dirName = IS_MACOS ? "Profiles" : baseDir;
  if (existsSync(dirName)) {
    const entries = await readdir(dirName, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const profilePath = join(dirName, entry.name);
      if (!candidates.some((c) => c.path === profilePath)) {
        candidates.push({ path: profilePath, isDefault: false });
      }
    }
  }

  const existing = candidates.filter((c) => existsSync(c.path));
  existing.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  return existing;
}

export function pickCandidatesByProfile(
  candidates: ProfileCandidate[],
  profile?: string,
): ProfileCandidate[] {
  const selector = profile?.trim();
  if (!selector) {
    return candidates;
  }
  const normalized = selector.toLowerCase();
  const matched = candidates.filter((c) => {
    const name = c.name?.toLowerCase() ?? "";
    const base = c.path.split("/").pop()?.toLowerCase() ?? "";
    const full = c.path.toLowerCase();
    return name === normalized || base === normalized || full.includes(normalized);
  });
  return matched;
}

export async function copySqliteForRead(
  dbPath: string,
): Promise<{ copyPath: string; cleanup: () => Promise<void> }> {
  const tmpPath = await mkdtemp(join(tmpdir(), "agent-slack-firefox-"));
  const base = dbPath.split("/").pop() || "db.sqlite";
  const copyPath = join(tmpPath, base);
  await copyFile(dbPath, copyPath);

  // Firefox keeps recent commits in WAL/SHM while running; copy them with the DB snapshot.
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${dbPath}${suffix}`;
    if (!existsSync(sidecar)) {
      continue;
    }
    try {
      await copyFile(sidecar, `${copyPath}${suffix}`);
    } catch {}
  }

  return {
    copyPath,
    cleanup: async () => {
      try {
        await rm(tmpPath, { recursive: true, force: true });
      } catch {}
    },
  };
}
