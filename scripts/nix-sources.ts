export const NIX_SYSTEM_ASSETS = [
  { system: "aarch64-darwin", asset: "agent-slack-darwin-arm64" },
  { system: "x86_64-darwin", asset: "agent-slack-darwin-x64" },
  { system: "aarch64-linux", asset: "agent-slack-linux-arm64" },
  { system: "x86_64-linux", asset: "agent-slack-linux-x64" },
] as const;

export type NixSystem = (typeof NIX_SYSTEM_ASSETS)[number]["system"];

export type NixSources = {
  version: string;
  hashes: Record<NixSystem, string>;
};

export type GithubReleaseAsset = {
  name?: string;
  digest?: string;
  browser_download_url?: string;
};

export type GithubRelease = {
  tag_name?: string;
  assets?: GithubReleaseAsset[];
};

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function hexToSri(hex: string): string {
  const clean = hex
    .trim()
    .toLowerCase()
    .replace(/^sha256:/, "");
  if (!SHA256_HEX.test(clean)) {
    throw new Error(`invalid sha256 hex: ${hex}`);
  }
  return `sha256-${Buffer.from(clean, "hex").toString("base64")}`;
}

export function parseChecksums(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const match = trimmed.match(/^([0-9a-fA-F]{64})\s+\*?(\S+)$/);
    if (!match) {
      continue;
    }
    const [, hex, asset] = match;
    if (!hex || !asset) {
      continue;
    }
    map.set(asset, hex.toLowerCase());
  }
  return map;
}

export function versionFromTag(tagName: string | undefined): string {
  const tag = tagName?.trim() ?? "";
  if (!tag || tag === "null") {
    throw new Error("unable to resolve latest release tag");
  }
  return tag.replace(/^v/, "");
}

function parseDigest(digest: string | undefined): string | undefined {
  if (!digest) {
    return undefined;
  }
  const match = digest.trim().match(/^(?:sha256:)?([0-9a-fA-F]{64})$/);
  const hex = match?.[1];
  return hex ? hex.toLowerCase() : undefined;
}

export function hashesFromRelease(input: {
  assets: GithubReleaseAsset[];
  checksums?: string;
}): Record<NixSystem, string> {
  const { assets, checksums } = input;
  const byName = new Map(
    assets.flatMap((asset) => {
      const name = asset.name?.trim();
      return name ? [[name, asset] as const] : [];
    }),
  );
  const fromChecksums = checksums ? parseChecksums(checksums) : undefined;
  const hashes = {} as Record<NixSystem, string>;

  for (const { system, asset } of NIX_SYSTEM_ASSETS) {
    const releaseAsset = byName.get(asset);
    const hex = parseDigest(releaseAsset?.digest) ?? fromChecksums?.get(asset);
    if (!hex) {
      throw new Error(`missing checksum for ${asset}`);
    }
    hashes[system] = hexToSri(hex);
  }

  return hashes;
}

export function buildNixSources(input: {
  version: string;
  hashes: Record<NixSystem, string>;
}): NixSources {
  return {
    version: input.version,
    hashes: input.hashes,
  };
}

export function formatSourcesJson(sources: NixSources): string {
  return `${JSON.stringify(sources, null, 2)}\n`;
}

export async function fetchLatestRelease(input: {
  repo: string;
  token?: string;
  fetchImpl?: FetchLike;
}): Promise<GithubRelease> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
  };
  if (input.token) {
    headers.Authorization = `Bearer ${input.token}`;
  }
  const response = await fetchImpl(`https://api.github.com/repos/${input.repo}/releases/latest`, {
    headers,
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} fetching latest release`);
  }
  return (await response.json()) as GithubRelease;
}

export async function fetchChecksumsFile(input: {
  url: string;
  token?: string;
  fetchImpl?: FetchLike;
}): Promise<string> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const headers: Record<string, string> = {};
  if (input.token) {
    headers.Authorization = `Bearer ${input.token}`;
  }
  const response = await fetchImpl(input.url, { headers });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching checksums from ${input.url}`);
  }
  return await response.text();
}

export function checksumsUrlForTag(input: { repo: string; tag: string }): string {
  return `https://github.com/${input.repo}/releases/download/${input.tag}/checksums-sha256.txt`;
}

export async function resolveNixSources(input: {
  repo: string;
  token?: string;
  fetchImpl?: FetchLike;
  release?: GithubRelease;
  checksums?: string;
}): Promise<NixSources> {
  const release = input.release ?? (await fetchLatestRelease(input));
  const tag = release.tag_name?.trim() ?? "";
  const version = versionFromTag(tag);
  const assets = Array.isArray(release.assets) ? release.assets : [];

  try {
    return buildNixSources({
      version,
      hashes: hashesFromRelease({ assets, checksums: input.checksums }),
    });
  } catch (error) {
    if (input.checksums !== undefined) {
      throw error;
    }
    const checksums = await fetchChecksumsFile({
      url: checksumsUrlForTag({ repo: input.repo, tag }),
      token: input.token,
      fetchImpl: input.fetchImpl,
    });
    return buildNixSources({
      version,
      hashes: hashesFromRelease({ assets, checksums }),
    });
  }
}
