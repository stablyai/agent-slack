import { WebClient } from "@slack/web-api";

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
    if (auth.auth_type === "standard") this.web = new WebClient(auth.token);
  }

  async api(method: string, params: Record<string, any> = {}): Promise<any> {
    if (this.auth.auth_type === "standard") {
      if (!this.web) throw new Error("WebClient not initialized");
      return this.web.apiCall(method, params);
    }

    if (!this.workspaceUrl) {
      throw new Error(
        "Browser auth requires workspace URL. Provide --workspace-url or set SLACK_WORKSPACE_URL, or call via a Slack message URL.",
      );
    }
    return this.browserApi(this.workspaceUrl, this.auth, method, params);
  }

  private async browserApi(
    workspaceUrl: string,
    auth: Extract<SlackAuth, { auth_type: "browser" }>,
    method: string,
    params: Record<string, any>,
    attempt = 0,
  ): Promise<any> {
    const url = `${workspaceUrl.replace(/\/$/, "")}/api/${method}`;
    const formBody = new URLSearchParams({
      token: auth.xoxc_token,
      ...Object.fromEntries(
        Object.entries(params).filter(([, v]) => v !== undefined),
      ),
    });
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Cookie: `d=${encodeURIComponent(auth.xoxd_cookie)}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://app.slack.com",
        "User-Agent": "agent-slack/0.1.0",
      },
      body: formBody,
    });

    if (response.status === 429 && attempt < 3) {
      const retryAfter = Number(response.headers.get("Retry-After") ?? "5");
      const delayMs = Math.min(Math.max(retryAfter, 1) * 1000, 30000);
      await new Promise((r) => setTimeout(r, delayMs));
      return this.browserApi(workspaceUrl, auth, method, params, attempt + 1);
    }

    const data: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`Slack HTTP ${response.status} calling ${method}`);
    }
    if (!data.ok) {
      throw new Error(data.error || `Slack API error calling ${method}`);
    }
    return data;
  }
}
