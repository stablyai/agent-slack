import { describe, expect, test } from "bun:test";
import { parseSlackCurlCommand } from "../src/auth/curl.ts";

function copiedCurl(url: string): string {
  return `curl '${url}' -H 'Cookie: d=xoxd-test' --data-raw 'token=xoxc-test'`;
}

describe("parseSlackCurlCommand workspace origin", () => {
  test("imports commercial, Enterprise, and GovSlack API requests", () => {
    expect(parseSlackCurlCommand(copiedCurl("https://team.slack.com/api/auth.test"))).toMatchObject(
      {
        workspace_url: "https://team.slack.com",
        xoxc_token: "xoxc-test",
        xoxd_cookie: "xoxd-test",
      },
    );
    expect(
      parseSlackCurlCommand(copiedCurl("https://acme.enterprise.slack.com/api/auth.test")),
    ).toMatchObject({
      workspace_url: "https://acme.enterprise.slack.com",
    });
    expect(
      parseSlackCurlCommand(copiedCurl("https://agency.slack-gov.com/api/auth.test")),
    ).toMatchObject({
      workspace_url: "https://agency.slack-gov.com",
    });
  });

  test("rejects unsafe copied request origins", () => {
    const invalid = [
      "http://team.slack.com/api/auth.test",
      "https://team.slack.com.evil.test/api/auth.test",
      "https://team.slack.com@collector.test/api/auth.test",
      "https://user@team.slack.com/api/auth.test",
      "https://team.slack.com:8443/api/auth.test",
    ];

    for (const url of invalid) {
      expect(() => parseSlackCurlCommand(copiedCurl(url)), url).toThrow(
        "canonical HTTPS Slack or GovSlack origin",
      );
    }
  });
});
