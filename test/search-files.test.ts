import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  searchFilesInChannelsFallback,
  searchFilesViaSearchApi,
} from "../src/slack/search-files.ts";
import type { SlackAuth, SlackApiClient } from "../src/slack/client.ts";

const AUTH: SlackAuth = { auth_type: "standard", token: "xoxb-test" };
const originalFetch = globalThis.fetch;

function setFetchSequence(responses: Response[]) {
  let index = 0;
  const mocked = mock(() => {
    const response = responses[index] ?? responses.at(-1);
    index += 1;
    return Promise.resolve(response!);
  }) as unknown as typeof globalThis.fetch;
  mocked.preconnect = () => {};
  globalThis.fetch = mocked;
  return mocked;
}

describe("searchFilesViaSearchApi", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agent-slack-test-"));
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    process.env.XDG_RUNTIME_DIR = undefined;
    await rm(tempDir, { recursive: true, force: true });
  });

  test("skips failed downloads and keeps later successful matches", async () => {
    process.env.XDG_RUNTIME_DIR = tempDir;
    setFetchSequence([
      new Response(null, { status: 404 }),
      new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    ]);

    const result = await searchFilesViaSearchApi({} as SlackApiClient, {
      auth: AUTH,
      slack_query: "report",
      limit: 5,
      contentType: "file",
      rawMatches: [
        {
          id: "F1",
          title: "Missing report",
          mimetype: "text/plain",
          url_private: "https://files.slack.com/files/F1",
        },
        {
          id: "F2",
          title: "Working report",
          mimetype: "text/plain",
          url_private: "https://files.slack.com/files/F2",
        },
      ],
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      title: "Working report",
      mimetype: "text/plain",
    });
    expect(result[0]!.path.endsWith("/F2.txt")).toBe(true);
  });
});

describe("searchFilesInChannelsFallback", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agent-slack-test-"));
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    process.env.XDG_RUNTIME_DIR = undefined;
    await rm(tempDir, { recursive: true, force: true });
  });

  test("continues after a failed download in files.list results", async () => {
    process.env.XDG_RUNTIME_DIR = tempDir;
    setFetchSequence([
      new Response(null, { status: 404 }),
      new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    ]);

    const client = {
      api: mock(async (method: string) => {
        if (method !== "files.list") {
          throw new Error(`Unexpected method: ${method}`);
        }
        return {
          files: [
            {
              id: "F1",
              title: "Broken report",
              mimetype: "text/plain",
              url_private: "https://files.slack.com/files/F1",
            },
            {
              id: "F2",
              title: "Healthy report",
              mimetype: "text/plain",
              url_private: "https://files.slack.com/files/F2",
            },
          ],
          paging: { pages: 1 },
        };
      }),
    } as unknown as SlackApiClient;

    const result = await searchFilesInChannelsFallback(client, {
      auth: AUTH,
      query: "report",
      channels: ["C12345678"],
      limit: 5,
      contentType: "file",
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      title: "Healthy report",
      mimetype: "text/plain",
    });
    expect(result[0]!.path.endsWith("/F2.txt")).toBe(true);
  });
});
