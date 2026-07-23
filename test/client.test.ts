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

describe("SlackApiClient browser origin guard", () => {
  test("rejects unsafe workspace origins when constructing a browser client", () => {
    const fetchMock = mock(async () => new Response(JSON.stringify({ ok: true })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    for (const workspaceUrl of [
      "http://workspace.slack.com",
      "https://collector.example",
      "https://workspace.slack.com.evil.test",
      "https://workspace.slack.com:8443",
      "https://user@workspace.slack.com",
    ]) {
      expect(() => new SlackApiClient(browserAuth(), { workspaceUrl }), workspaceUrl).toThrow(
        "canonical HTTPS Slack or GovSlack origin",
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("revalidates the workspace origin immediately before both browser transports", async () => {
    const fetchMock = mock(async () => new Response(JSON.stringify({ ok: true })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new SlackApiClient(browserAuth(), {
      workspaceUrl: "https://workspace.slack.com",
    });

    const mutableClient = client as unknown as { workspaceUrl: string };
    mutableClient.workspaceUrl = "https://collector.example";

    await expect(client.api("auth.test")).rejects.toThrow(
      "canonical HTTPS Slack or GovSlack origin",
    );
    await expect(client.apiMultipart("files.createCanvas")).rejects.toThrow(
      "canonical HTTPS Slack or GovSlack origin",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("uses the GovSlack API and app origins without following redirects", async () => {
    const fetchMock = mock(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new SlackApiClient(browserAuth(), {
      workspaceUrl: "https://AGENCY.slack-gov.com/",
    });

    await expect(client.api("auth.test")).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://agency.slack-gov.com/api/auth.test");
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toMatchObject({
      Origin: "https://app.slack-gov.com",
      Cookie: "d=xoxd-test",
    });
  });
});

describe("SlackApiClient standard token realm routing", () => {
  function webApiUrl(client: SlackApiClient): string {
    return (client as unknown as { web: { slackApiUrl: string } }).web.slackApiUrl;
  }

  test("uses the GovSlack Web API root for a GovSlack workspace", () => {
    const client = new SlackApiClient(
      { auth_type: "standard", token: "xoxb-test" },
      { workspaceUrl: "https://agency.slack-gov.com" },
    );
    expect(webApiUrl(client)).toBe("https://slack-gov.com/api/");
  });

  test("keeps the commercial Web API root for a commercial workspace", () => {
    const client = new SlackApiClient(
      { auth_type: "standard", token: "xoxb-test" },
      { workspaceUrl: "https://team.slack.com" },
    );
    expect(webApiUrl(client)).toBe("https://slack.com/api/");
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
