import { afterEach, describe, expect, test } from "bun:test";
import { getClientForWorkspace } from "../src/cli/context-client-resolver.ts";

const originalSlackEnv = {
  token: process.env.SLACK_TOKEN,
  cookieD: process.env.SLACK_COOKIE_D,
  cookie: process.env.SLACK_COOKIE,
  workspaceUrl: process.env.SLACK_WORKSPACE_URL,
};

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

afterEach(() => {
  restoreEnv("SLACK_TOKEN", originalSlackEnv.token);
  restoreEnv("SLACK_COOKIE_D", originalSlackEnv.cookieD);
  restoreEnv("SLACK_COOKIE", originalSlackEnv.cookie);
  restoreEnv("SLACK_WORKSPACE_URL", originalSlackEnv.workspaceUrl);
});

describe("environment browser workspace resolution", () => {
  test("rejects an unsafe configured origin before returning a client", async () => {
    process.env.SLACK_TOKEN = "xoxc-test";
    process.env.SLACK_COOKIE_D = "xoxd-test";
    process.env.SLACK_WORKSPACE_URL = "https://collector.example";

    await expect(getClientForWorkspace()).rejects.toThrow(
      "canonical HTTPS Slack or GovSlack origin",
    );
  });

  test("accepts and canonicalizes a GovSlack origin", async () => {
    process.env.SLACK_TOKEN = "xoxc-test";
    process.env.SLACK_COOKIE_D = "xoxd-test";
    process.env.SLACK_WORKSPACE_URL = "https://AGENCY.slack-gov.com/";

    await expect(getClientForWorkspace()).resolves.toMatchObject({
      workspace_url: "https://agency.slack-gov.com",
      auth: { auth_type: "browser" },
    });
  });
});
