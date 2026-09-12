import { afterEach, describe, expect, mock, test } from "bun:test";
import { SlackApiClient } from "../src/slack/client.ts";

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  delete process.env.AGENT_SLACK_RATE_LIMIT_MAX_WAIT_MS;
});

describe("SlackApiClient browser email lookup", () => {
  test("uses a fixed Slack edge origin and a bounded local-part search", async () => {
    const fetchMock = mock(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true, results: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new SlackApiClient(
      {
        auth_type: "browser",
        xoxc_token: "xoxc-test",
        xoxd_cookie: "xoxd-test",
      },
      { workspaceUrl: "https://workspace.slack.com" },
    );

    await expect(client.lookupUserByEmail("person@example.com", "E12345678")).resolves.toEqual({
      ok: true,
      results: [],
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://edgeapi.slack.com/cache/E12345678/users/search");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: "Bearer xoxc-test",
        Origin: "https://app.slack.com",
        "Content-Type": "application/json",
      },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      query: "person",
      count: 25,
      include_profile_only_users: false,
      fuzz: 0,
      uax29_tokenizer: false,
      filter: "NOT deactivated",
    });
  });

  test("rejects malformed edge cache IDs before sending browser credentials", async () => {
    const fetchMock = mock(async () => new Response(JSON.stringify({ ok: true })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new SlackApiClient(
      {
        auth_type: "browser",
        xoxc_token: "xoxc-test",
        xoxd_cookie: "xoxd-test",
      },
      { workspaceUrl: "https://workspace.slack.com" },
    );

    await expect(
      client.lookupUserByEmail("person@example.com", "../../collector.example"),
    ).rejects.toThrow("authenticated Slack team or enterprise ID");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("SlackApiClient browser multipart transport", () => {
  test("retries HTTP 429 responses using Retry-After", async () => {
    // Fail-fast defaults to 0ms; opt in to waiting so the retry path runs.
    process.env.AGENT_SLACK_RATE_LIMIT_MAX_WAIT_MS = "30000";
    const responses = [
      new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "2" },
      }),
      new Response(JSON.stringify({ ok: true, file_id: "F12345678" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ];
    const fetchMock = mock(async (_input: string | URL | Request, _init?: RequestInit) => {
      return responses.shift()!;
    });
    const delays: number[] = [];
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    globalThis.setTimeout = ((callback: () => void, delay?: number) => {
      delays.push(delay ?? 0);
      callback();
      return 0;
    }) as unknown as typeof setTimeout;

    const client = new SlackApiClient(
      {
        auth_type: "browser",
        xoxc_token: "xoxc-test",
        xoxd_cookie: "xoxd-test",
      },
      { workspaceUrl: "https://workspace.slack.com" },
    );

    await expect(
      client.apiMultipart("files.createCanvas", {
        title: "Launch plan",
        markdown: "# Launch plan\n",
      }),
    ).resolves.toEqual({ ok: true, file_id: "F12345678" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([2000]);
    for (const call of fetchMock.mock.calls) {
      expect(call[1]?.body).toBeInstanceOf(FormData);
    }
  });
});
