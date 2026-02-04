import { WebClient } from "@slack/web-api";
import { getUserAgent } from "../lib/version.ts";

export type SlackAuth =
  | { auth_type: "standard"; token: string }
  | { auth_type: "browser"; xoxc_token: string; xoxd_cookie: string };

export class SlackApiClient {
  private auth: SlackAuth;
  private web?: WebClient;
  private workspaceUrl?: string;

  constructor(auth: SlackAuth, options?: { workspaceUrl?: string }) {
    this.auth = auth;
    this.workspaceUrl = options?.workspaceUrl;
    if (auth.auth_type === "standard") {
      this.web = new WebClient(auth.token);
    }
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
    const url = `${input.workspaceUrl.replace(/\/$/, "")}/api/${input.method}`;
    const cleanedEntries = Object.entries(input.params)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, String(v)]);
    const formBody = new URLSearchParams({
      token: input.auth.xoxc_token,
      ...Object.fromEntries(cleanedEntries),
    });
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Cookie: `d=${encodeURIComponent(input.auth.xoxd_cookie)}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://app.slack.com",
        "User-Agent": getUserAgent(),
      },
      body: formBody,
    });

    if (response.status === 429 && attempt < 3) {
      const retryAfter = Number(response.headers.get("Retry-After") ?? "5");
      const delayMs = Math.min(Math.max(retryAfter, 1) * 1000, 30000);
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
