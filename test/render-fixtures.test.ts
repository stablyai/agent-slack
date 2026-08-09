import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderSlackMessageContent } from "../src/slack/render.ts";

/**
 * Fixture-pair harness: every `test/fixtures/render/<name>.json` (a raw message
 * object as passed to renderSlackMessageContent) must render exactly to the
 * markdown in the sibling `<name>.txt`. Add a new case by dropping in a pair.
 * Expected outputs are .txt, not .md, so formatters (oxfmt pre-commit) never
 * rewrite them — they are exact renderer output, not prose.
 *
 * Regenerate expected outputs after an intentional rendering change with:
 *   UPDATE_RENDER_FIXTURES=1 bun test render-fixtures
 */
const FIXTURES_DIR = join(import.meta.dir, "fixtures", "render");
const UPDATE = process.env.UPDATE_RENDER_FIXTURES === "1";

const fixtureNames = readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""))
  .sort();

describe("render fixtures", () => {
  test("fixture directory is not empty", () => {
    expect(fixtureNames.length).toBeGreaterThan(0);
  });

  for (const name of fixtureNames) {
    test(name, () => {
      const input = JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), "utf8"));
      const rendered = renderSlackMessageContent(input);
      const expectedPath = join(FIXTURES_DIR, `${name}.txt`);
      if (UPDATE) {
        writeFileSync(expectedPath, rendered ? `${rendered}\n` : "");
        return;
      }
      const expected = readFileSync(expectedPath, "utf8").replace(/\n$/, "");
      expect(rendered).toBe(expected);
    });
  }
});
