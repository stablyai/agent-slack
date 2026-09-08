import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NIX_SYSTEM_ASSETS,
  buildNixSources,
  checksumsUrlForTag,
  formatSourcesJson,
  hashesFromRelease,
  hexToSri,
  parseChecksums,
  resolveNixSources,
  versionFromTag,
  type FetchLike,
  type GithubRelease,
} from "../scripts/nix-sources.ts";

const V0_5_2_DARWIN_ARM64_HEX = "fda9b131a2f033199fc87a94667f1b29debf6e3af1fe09424b32d26c5b3e90a9";
const V0_5_2_DARWIN_ARM64_SRI = "sha256-/amxMaLwMxmfyHqUZn8bKd6/bjrx/glCSzLSbFs+kKk=";

const V0_10_2_HEX = {
  "agent-slack-darwin-arm64": "ff900d5c764033b737662113b4e8c5a953dfe2645b8708536f41867add54fe3b",
  "agent-slack-darwin-x64": "791fea721447e15a6b43784797ec8a19c5c079d6a2b3ce3bbd2a416e54bef87f",
  "agent-slack-linux-arm64": "02e71a69816aa679b2eb5756fee9349195fd728da99e6582dc6ac1a76f63f1ee",
  "agent-slack-linux-x64": "ad4d65d4ee2c83ec7eba593951568e8b7c9722b72971a09e8cae6e090057d483",
} as const;

describe("hexToSri", () => {
  test("should convert a known v0.5.2 release digest to the committed SRI hash", () => {
    expect(hexToSri(V0_5_2_DARWIN_ARM64_HEX)).toBe(V0_5_2_DARWIN_ARM64_SRI);
  });

  test("should accept a sha256: prefix", () => {
    expect(hexToSri(`sha256:${V0_5_2_DARWIN_ARM64_HEX}`)).toBe(V0_5_2_DARWIN_ARM64_SRI);
  });

  test("should reject truncated or non-hex input", () => {
    expect(() => hexToSri("abcd")).toThrow("invalid sha256 hex");
    expect(() => hexToSri("g".repeat(64))).toThrow("invalid sha256 hex");
  });
});

describe("parseChecksums", () => {
  test("should parse GNU text-mode and binary-mode checksum lines", () => {
    const parsed = parseChecksums(
      [
        `${V0_10_2_HEX["agent-slack-darwin-arm64"]}  agent-slack-darwin-arm64`,
        `${V0_10_2_HEX["agent-slack-darwin-x64"]} *agent-slack-darwin-x64`,
        "not-a-checksum-line",
        "",
      ].join("\n"),
    );

    expect(parsed.get("agent-slack-darwin-arm64")).toBe(V0_10_2_HEX["agent-slack-darwin-arm64"]);
    expect(parsed.get("agent-slack-darwin-x64")).toBe(V0_10_2_HEX["agent-slack-darwin-x64"]);
    expect(parsed.size).toBe(2);
  });
});

describe("versionFromTag", () => {
  test("should strip a leading v from GitHub release tags", () => {
    expect(versionFromTag("v0.10.2")).toBe("0.10.2");
  });

  test("should reject missing tags", () => {
    expect(() => versionFromTag(undefined)).toThrow("unable to resolve latest release tag");
    expect(() => versionFromTag("null")).toThrow("unable to resolve latest release tag");
    expect(() => versionFromTag("  ")).toThrow("unable to resolve latest release tag");
  });
});

describe("hashesFromRelease", () => {
  test("should prefer GitHub asset digest fields when present", () => {
    const hashes = hashesFromRelease({
      assets: NIX_SYSTEM_ASSETS.map(({ asset }) => ({
        name: asset,
        digest: `sha256:${V0_10_2_HEX[asset]}`,
      })),
    });

    expect(hashes["aarch64-darwin"]).toBe(hexToSri(V0_10_2_HEX["agent-slack-darwin-arm64"]));
    expect(hashes["x86_64-darwin"]).toBe(hexToSri(V0_10_2_HEX["agent-slack-darwin-x64"]));
    expect(hashes["aarch64-linux"]).toBe(hexToSri(V0_10_2_HEX["agent-slack-linux-arm64"]));
    expect(hashes["x86_64-linux"]).toBe(hexToSri(V0_10_2_HEX["agent-slack-linux-x64"]));
  });

  test("should fall back to checksums-sha256.txt when digest is missing", () => {
    const hashes = hashesFromRelease({
      assets: [{ name: "agent-slack-darwin-arm64" }, { name: "agent-slack-darwin-x64" }],
      checksums: NIX_SYSTEM_ASSETS.map(({ asset }) => `${V0_10_2_HEX[asset]}  ${asset}`).join("\n"),
    });

    expect(hashes["aarch64-linux"]).toBe(hexToSri(V0_10_2_HEX["agent-slack-linux-arm64"]));
  });

  test("should throw when an asset has neither digest nor checksum", () => {
    expect(() =>
      hashesFromRelease({
        assets: [
          {
            name: "agent-slack-darwin-arm64",
            digest: `sha256:${V0_10_2_HEX["agent-slack-darwin-arm64"]}`,
          },
        ],
      }),
    ).toThrow("missing checksum for agent-slack-darwin-x64");
  });
});

describe("resolveNixSources", () => {
  test("should fetch checksums when the latest release omits asset digests", async () => {
    const release: GithubRelease = {
      tag_name: "v0.10.2",
      assets: NIX_SYSTEM_ASSETS.map(({ asset }) => ({ name: asset })),
    };
    const checksums = NIX_SYSTEM_ASSETS.map(({ asset }) => `${V0_10_2_HEX[asset]}  ${asset}`).join(
      "\n",
    );
    const checksumsUrl = checksumsUrlForTag({ repo: "stablyai/agent-slack", tag: "v0.10.2" });
    const fetchImpl: FetchLike = async (url) => {
      if (String(url) !== checksumsUrl) {
        throw new Error(`unexpected fetch: ${String(url)}`);
      }
      return new Response(checksums, { status: 200 });
    };

    const sources = await resolveNixSources({
      repo: "stablyai/agent-slack",
      release,
      fetchImpl,
    });

    expect(sources.version).toBe("0.10.2");
    expect(sources.hashes["x86_64-linux"]).toBe(hexToSri(V0_10_2_HEX["agent-slack-linux-x64"]));
  });
});

describe("formatSourcesJson", () => {
  test("should serialize a trailing newline so the file stays oxfmt-stable", () => {
    const sources = buildNixSources({
      version: "0.10.2",
      hashes: hashesFromRelease({
        assets: NIX_SYSTEM_ASSETS.map(({ asset }) => ({
          name: asset,
          digest: `sha256:${V0_10_2_HEX[asset]}`,
        })),
      }),
    });

    expect(formatSourcesJson(sources)).toBe(`${JSON.stringify(sources, null, 2)}\n`);
  });
});

describe("nix/sources.json", () => {
  test("should list an SRI hash for every flake system", () => {
    const path = join(dirname(fileURLToPath(import.meta.url)), "..", "nix", "sources.json");
    const sources = JSON.parse(readFileSync(path, "utf8")) as {
      version?: unknown;
      hashes?: Record<string, unknown>;
    };

    expect(typeof sources.version).toBe("string");
    expect(String(sources.version)).toMatch(/^\d+\.\d+\.\d+/);

    for (const { system } of NIX_SYSTEM_ASSETS) {
      expect(sources.hashes?.[system]).toMatch(/^sha256-[A-Za-z0-9+/=]+$/);
    }
  });
});
