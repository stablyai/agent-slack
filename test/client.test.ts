import { afterEach, describe, expect, mock, test } from "bun:test";
import { SlackApiClient } from "../src/slack/client.ts";

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  delete process.env.AGENT_SLACK_RATE_LIMIT_MAX_WAIT_MS;
});

function browserAuth() {
  return {
    auth_type: "browser" as const,
    xoxc_token: "xoxc-test",
    xoxd_cookie: "xoxd-test",
  };
}

describe("SlackApiClient credential destinations", () => {
  test("rejects unsafe workspace origins before browser credentials can be sent", () => {
    const fetchMock = mock(async () => new Response(JSON.stringify({ ok: true })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(
      () => new SlackApiClient(browserAuth(), { workspaceUrl: "https://collector.example" }),
    ).toThrow("canonical HTTPS Slack workspace origin");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("revalidates immediately before both browser transports", async () => {
    const fetchMock = mock(async () => new Response(JSON.stringify({ ok: true })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new SlackApiClient(browserAuth(), {
      workspaceUrl: "https://workspace.slack.com",
    });

    (client as unknown as { workspaceUrl: string }).workspaceUrl = "https://collector.example";

    await expect(client.api("auth.test")).rejects.toThrow("canonical HTTPS Slack workspace origin");
    await expect(client.apiMultipart("files.createCanvas")).rejects.toThrow(
      "canonical HTTPS Slack workspace origin",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects redirects for both browser transports", async () => {
    const fetchMock = mock(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true })),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new SlackApiClient(browserAuth(), {
      workspaceUrl: "https://workspace.slack.com",
    });

    await expect(client.api("auth.test")).resolves.toEqual({ ok: true });
    await expect(client.apiMultipart("files.createCanvas")).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(call[1]?.redirect).toBe("error");
    }
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

    const client = new SlackApiClient(browserAuth(), {
      workspaceUrl: "https://workspace.slack.com",
    });

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
      expect(call[1]?.redirect).toBe("error");
    }
  });
});
