import { WebClient } from "@slack/web-api";
import { getUserAgent } from "../lib/version.ts";
import {
  normalizeSlackWorkspaceUrl,
  slackApiUrlForWorkspace,
  slackAppOriginForWorkspace,
} from "./workspace-url.ts";

export type SlackAuth =
  | { auth_type: "standard"; token: string }
  | { auth_type: "browser"; xoxc_token: string; xoxd_cookie: string };

const DEFAULT_SLACK_API_TIMEOUT_MS = 20_000;
const DEFAULT_SLACK_RATE_LIMIT_MAX_WAIT_MS = 0;

function getSlackApiTimeoutMs(): number {
  const raw =
    process.env.AGENT_SLACK_API_TIMEOUT_MS?.trim() || process.env.SLACK_API_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_SLACK_API_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SLACK_API_TIMEOUT_MS;
  }
  return Math.floor(parsed);
}

function getSlackRateLimitMaxWaitMs(): number {
  const raw = process.env.AGENT_SLACK_RATE_LIMIT_MAX_WAIT_MS?.trim();
  if (!raw) {
    return DEFAULT_SLACK_RATE_LIMIT_MAX_WAIT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_SLACK_RATE_LIMIT_MAX_WAIT_MS;
  }
  return Math.floor(parsed);
}

function slackApiTimeoutError(method: string, timeoutMs: number): Error {
  return new Error(
    `Slack API call ${method} timed out after ${timeoutMs}ms. Set AGENT_SLACK_API_TIMEOUT_MS to adjust.`,
  );
}

function slackRateLimitError(input: {
  method: string;
  retryAfterSec: number;
  maxWaitMs: number;
}): Error {
  return new Error(
    `Slack API call ${input.method} was rate limited; retry-after ${input.retryAfterSec}s exceeds AGENT_SLACK_RATE_LIMIT_MAX_WAIT_MS=${input.maxWaitMs}.`,
  );
}

function timeoutSignal(timeoutMs: number): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(timeoutMs)
    : undefined;
}

function isAbortOrTimeoutError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  const name = typeof error.name === "string" ? error.name : "";
  const code = typeof error.code === "string" ? error.code : "";
  return (
    name === "AbortError" ||
    name === "TimeoutError" ||
    code === "ABORT_ERR" ||
    code === "ECONNABORTED"
  );
}

export class SlackApiClient {
  private auth: SlackAuth;
  private web?: WebClient;
  private workspaceUrl?: string;

  constructor(auth: SlackAuth, options?: { workspaceUrl?: string }) {
    this.auth = auth;
    this.workspaceUrl = options?.workspaceUrl
      ? normalizeSlackWorkspaceUrl(options.workspaceUrl)
      : undefined;
    if (auth.auth_type === "standard") {
      this.web = new WebClient(auth.token, {
        slackApiUrl: this.workspaceUrl
          ? slackApiUrlForWorkspace(this.workspaceUrl)
          : "https://slack.com/api/",
        allowAbsoluteUrls: false,
        timeout: getSlackApiTimeoutMs(),
        retryConfig: { retries: 0 },
        rejectRateLimitedCalls: true,
      });
    }
  }

  /**
   * Call a Slack API method using multipart/form-data encoding.
   * Some internal Slack APIs (e.g. saved.update) require multipart encoding
   * and silently ignore parameters sent as application/x-www-form-urlencoded.
   */
  async apiMultipart(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    if (this.auth.auth_type === "standard") {
      // Standard tokens can use the normal API path
      return this.api(method, params);
    }
    if (!this.workspaceUrl) {
      throw new Error("Browser auth requires workspace URL.");
    }
    const auth = this.auth as Extract<SlackAuth, { auth_type: "browser" }>;
    return this.browserApiMultipart({
      workspaceUrl: this.workspaceUrl,
      auth,
      method,
      params,
    });
  }

  private async browserApiMultipart(input: {
    workspaceUrl: string;
    auth: Extract<SlackAuth, { auth_type: "browser" }>;
    method: string;
    params: Record<string, unknown>;
    attempt?: number;
  }): Promise<Record<string, unknown>> {
    const attempt = input.attempt ?? 0;
    const workspaceUrl = normalizeSlackWorkspaceUrl(input.workspaceUrl);
    const url = `${workspaceUrl}/api/${input.method}`;
    const fd = new FormData();
    fd.append("token", input.auth.xoxc_token);
    for (const [k, v] of Object.entries(input.params)) {
      if (v !== undefined) {
        fd.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
      }
    }
    const timeoutMs = getSlackApiTimeoutMs();
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        redirect: "error",
        headers: {
          Cookie: `d=${encodeURIComponent(input.auth.xoxd_cookie)}`,
          Origin: slackAppOriginForWorkspace(workspaceUrl),
          "User-Agent": getUserAgent(),
        },
        body: fd,
        signal: timeoutSignal(timeoutMs),
      });
    } catch (error) {
      if (isAbortOrTimeoutError(error)) {
        throw slackApiTimeoutError(input.method, timeoutMs);
      }
      throw error;
    }

    if (response.status === 429 && attempt < 3) {
      const retryAfter = Number(response.headers.get("Retry-After") ?? "5");
      const delayMs = Math.min(Math.max(retryAfter, 1) * 1000, 30000);
      const maxWaitMs = getSlackRateLimitMaxWaitMs();
      if (delayMs > maxWaitMs) {
        throw slackRateLimitError({ method: input.method, retryAfterSec: retryAfter, maxWaitMs });
      }
      await new Promise((r) => setTimeout(r, delayMs));
      return this.browserApiMultipart({
        ...input,
        attempt: attempt + 1,
      });
    }

    const data: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`Slack HTTP ${response.status} calling ${input.method}`);
    }
    if (!isRecord(data) || data.ok !== true) {
      const error = isRecord(data) && typeof data.error === "string" ? data.error : null;
      throw new Error(error || `Slack API error calling ${input.method}`);
    }
    return data;
  }

  async api(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    if (this.auth.auth_type === "standard") {
      if (!this.web) {
        throw new Error("WebClient not initialized");
      }
      return (await this.web.apiCall(method, params)) as unknown as Record<string, unknown>;
    }

    if (!this.workspaceUrl) {
      throw new Error(
        "Browser auth requires workspace URL. Provide --workspace-url or set SLACK_WORKSPACE_URL, or call via a Slack message URL.",
      );
    }
    const { auth } = this;
    if (auth.auth_type !== "browser") {
      throw new Error("Browser API requires browser auth");
    }
    return this.browserApi({
      workspaceUrl: this.workspaceUrl,
      auth,
      method,
      params,
    });
  }

  private async browserApi(input: {
    workspaceUrl: string;
    auth: Extract<SlackAuth, { auth_type: "browser" }>;
    method: string;
    params: Record<string, unknown>;
    attempt?: number;
  }): Promise<Record<string, unknown>> {
    const attempt = input.attempt ?? 0;
    const workspaceUrl = normalizeSlackWorkspaceUrl(input.workspaceUrl);
    const url = `${workspaceUrl}/api/${input.method}`;
    const cleanedEntries = Object.entries(input.params)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)]);
    const formBody = new URLSearchParams({
      token: input.auth.xoxc_token,
      ...Object.fromEntries(cleanedEntries),
    });
    const timeoutMs = getSlackApiTimeoutMs();
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        redirect: "error",
        headers: {
          Cookie: `d=${encodeURIComponent(input.auth.xoxd_cookie)}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: slackAppOriginForWorkspace(workspaceUrl),
          "User-Agent": getUserAgent(),
        },
        body: formBody,
        signal: timeoutSignal(timeoutMs),
      });
    } catch (error) {
      if (isAbortOrTimeoutError(error)) {
        throw slackApiTimeoutError(input.method, timeoutMs);
      }
      throw error;
    }

    if (response.status === 429 && attempt < 3) {
      const retryAfter = Number(response.headers.get("Retry-After") ?? "5");
      const delayMs = Math.min(Math.max(retryAfter, 1) * 1000, 30000);
      const maxWaitMs = getSlackRateLimitMaxWaitMs();
      if (delayMs > maxWaitMs) {
        throw slackRateLimitError({ method: input.method, retryAfterSec: retryAfter, maxWaitMs });
      }
      await new Promise((r) => setTimeout(r, delayMs));
      return this.browserApi({
        ...input,
        attempt: attempt + 1,
      });
    }

    const data: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`Slack HTTP ${response.status} calling ${input.method}`);
    }
    if (!isRecord(data) || data.ok !== true) {
      const error = isRecord(data) && typeof data.error === "string" ? data.error : null;
      throw new Error(error || `Slack API error calling ${input.method}`);
    }
    return data;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
