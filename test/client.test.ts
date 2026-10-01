import { afterEach, describe, expect, mock, test } from "bun:test";
import { SlackApiClient, slackErrorResponse } from "../src/slack/client.ts";
import { webApiPlatformError } from "./helpers/web-api-platform-error.ts";

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

function browserClientAnswering(response: Record<string, unknown>): SlackApiClient {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
  return new SlackApiClient(
    { auth_type: "browser", xoxc_token: "xoxc-test", xoxd_cookie: "xoxd-test" },
    { workspaceUrl: "https://workspace.slack.com" },
  );
}

describe("slackErrorResponse", () => {
  test("reads Slack's error and scopes from a browser-auth error", async () => {
    const client = browserClientAnswering({
      ok: false,
      error: "missing_scope",
      needed: "channels:write",
      provided: "chat:write",
    });

    const err = await client.api("conversations.join", { channel: "C0GENERAL1" }).catch((e) => e);

    expect(slackErrorResponse(err)).toEqual({
      error: "missing_scope",
      needed: "channels:write",
      provided: "chat:write",
    });
  });

  test("keeps Slack's error code as a browser-auth error's message", async () => {
    const client = browserClientAnswering({ ok: false, error: "channel_not_found" });

    const err = await client.api("conversations.join", { channel: "C00000000" }).catch((e) => e);

    expect(err.message).toBe("channel_not_found");
  });

  test("reads Slack's error and scopes from a standard-token error", () => {
    const err = webApiPlatformError({
      ok: false,
      error: "missing_scope",
      needed: "channels:write",
      provided: "chat:write",
    });

    expect(slackErrorResponse(err)).toEqual({
      error: "missing_scope",
      needed: "channels:write",
      provided: "chat:write",
    });
  });

  test("leaves out scopes Slack did not send", () => {
    const err = webApiPlatformError({ ok: false, error: "channel_not_found" });

    expect(slackErrorResponse(err)).toEqual({ error: "channel_not_found" });
  });

  test("is undefined for a browser-auth response without an error code", async () => {
    const client = browserClientAnswering({ ok: false });

    const err = await client.api("conversations.join", { channel: "C0GENERAL1" }).catch((e) => e);

    expect(slackErrorResponse(err)).toBeUndefined();
  });

  test("is undefined for a failure that never reached Slack", () => {
    expect(slackErrorResponse(new Error("fetch failed"))).toBeUndefined();
  });
});
