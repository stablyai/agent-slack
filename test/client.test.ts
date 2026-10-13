import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as store from "../src/auth/store.ts";
import { SlackApiClient } from "../src/slack/client.ts";

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  delete process.env.AGENT_SLACK_RATE_LIMIT_MAX_WAIT_MS;
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

describe("SlackApiClient.forWorkspace", () => {
  const browserAuth = {
    auth_type: "browser",
    xoxc_token: "xoxc-caller",
    xoxd_cookie: "d-caller",
  } as const;
  // Distinct from the caller's credentials so a regression reusing this.auth instead of
  // the stored workspace's auth cannot pass.
  const storedAuth = {
    auth_type: "browser",
    xoxc_token: "xoxc-org",
    xoxd_cookie: "d-org",
  } as const;
  const originalSlackToken = process.env.SLACK_TOKEN;

  afterEach(() => {
    mock.restore();
    if (originalSlackToken === undefined) {
      delete process.env.SLACK_TOKEN;
    } else {
      process.env.SLACK_TOKEN = originalSlackToken;
    }
  });

  test("returns a client for a stored workspace", async () => {
    delete process.env.SLACK_TOKEN;
    const spy = spyOn(store, "resolveWorkspaceForUrl").mockResolvedValue({
      workspace_url: "https://acme.enterprise.slack.com",
      auth: storedAuth,
    });
    const fetchMock = mock(async () => Response.json({ ok: true }));
    globalThis.fetch = fetchMock as never;

    const org = await new SlackApiClient(browserAuth).forWorkspace(
      "https://acme.enterprise.slack.com",
    );
    expect(org).not.toBeNull();
    expect(spy).toHaveBeenCalledWith("https://acme.enterprise.slack.com");

    await org?.api("auth.test");
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(
      "https://acme.enterprise.slack.com/api/auth.test",
    );
    const request = fetchMock.mock.calls[0] as unknown as [
      string,
      { body: FormData; headers: Record<string, string> },
    ];
    expect(request[1].body.get("token")).toBe("xoxc-org");
    expect(request[1].headers.Cookie).toContain("d-org");
  });

  test("returns null when the workspace is not stored", async () => {
    delete process.env.SLACK_TOKEN;
    spyOn(store, "resolveWorkspaceForUrl").mockResolvedValue(null);
    expect(
      await new SlackApiClient(browserAuth).forWorkspace("https://nope.enterprise.slack.com"),
    ).toBeNull();
  });

  test("returns null when SLACK_TOKEN is set, without reading stored credentials", async () => {
    process.env.SLACK_TOKEN = "xoxb-env";
    const spy = spyOn(store, "resolveWorkspaceForUrl");
    expect(
      await new SlackApiClient(browserAuth).forWorkspace("https://acme.enterprise.slack.com"),
    ).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
