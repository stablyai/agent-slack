import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { snappyCompress } from "hysnappy";

const team = { name: "Example", url: "https://example.slack.com/", token: "xoxc-test-token" };
const config = JSON.stringify({ teams: { T123: team }, padding: "repeat ".repeat(100) });

async function extractFixture(value: string | Uint8Array, compressionType: number) {
  const home = await mkdtemp(join(tmpdir(), "agent-slack-firefox-test-"));
  try {
    const base =
      platform() === "darwin"
        ? join(home, "Library", "Application Support", "Firefox")
        : join(home, ".mozilla", "firefox");
    const profile = join(base, "fixture");
    const storage = join(profile, "storage", "default", "https+++app.slack.com", "ls");
    await mkdir(storage, { recursive: true });
    await writeFile(
      join(base, "profiles.ini"),
      "[Profile0]\nName=fixture\nIsRelative=1\nPath=fixture\nDefault=1\n",
    );
    // Real SQLite files exercise discovery, snapshotting, querying and decoding together.
    const db = new Database(join(storage, "data.sqlite"));
    db.run("CREATE TABLE data (key TEXT, value BLOB, compression_type INTEGER)");
    db.run("INSERT INTO data VALUES (?, ?, ?)", ["localConfig_v2", value, compressionType]);
    db.close();
    const cookies = new Database(join(profile, "cookies.sqlite"));
    cookies.run("CREATE TABLE moz_cookies (host TEXT, name TEXT, value TEXT)");
    cookies.run("INSERT INTO moz_cookies VALUES ('.slack.com', 'd', 'xoxd-test-cookie')");
    cookies.close();
    // Avoid changing HOME or mocking shared modules in the test runner.
    const proc = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
      import { extractFromFirefox } from "./src/auth/firefox.ts";
      const result = await extractFromFirefox();
      console.log(JSON.stringify(result && { teams: result.teams, cookie_d: result.cookie_d }));
    `,
      ],
      { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" },
    );
    const output = await new Response(proc.stdout).text();
    const error = await new Response(proc.stderr).text();
    expect(await proc.exited, error).toBe(0);
    return JSON.parse(output);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

describe("Firefox auth storage", () => {
  for (const [name, value, compression] of [
    ["uncompressed text", config, 0],
    ["uncompressed blob", Buffer.from(config), 0],
    ["Snappy-compressed blob", snappyCompress(Buffer.from(config)), 1],
  ] as const) {
    test(`extracts ${name}`, async () => {
      expect(await extractFixture(value, compression)).toEqual({
        teams: [team],
        cookie_d: "xoxd-test-cookie",
      });
    });
  }

  test("does not parse corrupt compressed data as plaintext", async () => {
    expect(await extractFixture(Buffer.from(config), 1)).toBeNull();
  });

  for (const [name, value] of [
    ["empty", Buffer.alloc(0)],
    ["truncated length", Buffer.from([0x80])],
    ["unterminated length", Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80])],
    ["oversized allocation", Buffer.from([0xff, 0xff, 0xff, 0xff, 0x0f])],
  ] as const) {
    test(`ignores ${name} compressed data`, async () => {
      expect(await extractFixture(value, 1)).toBeNull();
    });
  }

  test("ignores unsupported compression types", async () => {
    expect(await extractFixture(Buffer.from(config), 2)).toBeNull();
  });
});
