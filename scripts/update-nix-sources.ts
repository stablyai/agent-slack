import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatSourcesJson, resolveNixSources } from "./nix-sources.ts";

const DEFAULT_REPO = "stablyai/agent-slack";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourcesPath = join(rootDir, "nix", "sources.json");

const sources = await resolveNixSources({
  repo: process.env.AGENT_SLACK_GITHUB_REPO?.trim() || DEFAULT_REPO,
  token: process.env.GITHUB_TOKEN?.trim() || undefined,
});

writeFileSync(sourcesPath, formatSourcesJson(sources));
console.log(`Updated nix/sources.json to ${sources.version}`);
