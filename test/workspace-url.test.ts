import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialsSchema, WorkspaceSchema } from "../src/auth/schema.ts";
import {
  browserCookieAccount,
  parseStoredCredentials,
  readStoredCredentials,
} from "../src/auth/store.ts";
import {
  normalizeSlackWorkspaceUrl,
  slackAppOriginForWorkspace,
  slackWorkspaceOriginFromUrl,
} from "../src/slack/workspace-url.ts";

describe("Slack workspace origins", () => {
  test("canonicalizes Slack and GovSlack origins", () => {
    expect(normalizeSlackWorkspaceUrl("https://TEAM.slack.com/")).toBe("https://team.slack.com");
    expect(normalizeSlackWorkspaceUrl("https://acme.enterprise.slack.com")).toBe(
      "https://acme.enterprise.slack.com",
    );
    expect(normalizeSlackWorkspaceUrl("https://agency.slack-gov.com/")).toBe(
      "https://agency.slack-gov.com",
    );
    expect(normalizeSlackWorkspaceUrl("https://app.slack.com:443")).toBe("https://app.slack.com");
    expect(normalizeSlackWorkspaceUrl("https://app.slack-gov.com")).toBe(
      "https://app.slack-gov.com",
    );
  });

  test("rejects non-canonical or non-Slack origins", () => {
    const invalid = [
      "http://team.slack.com",
      "https://example.com",
      "https://team.slack.com.evil.test",
      "https://evilslack.com",
      "https://slack.com",
      "https://slack-gov.com",
      "https://team.slack.com.",
      "https://user:password@team.slack.com",
      "https://team.slack.com@collector.example",
      "https://team.slack.com:8443",
      "https://team.slack.com/archives/C123",
      "https://team.slack.com?token=secret",
      "https://team.slack.com#fragment",
      "ftp://team.slack.com",
      "file:///tmp/slack",
      "javascript:alert(1)",
      "team.slack.com",
      "https://-.slack.com",
    ];

    for (const value of invalid) {
      expect(() => normalizeSlackWorkspaceUrl(value), value).toThrow(
        "canonical HTTPS Slack or GovSlack origin",
      );
    }
  });

  test("extracts canonical origins from validated Slack resource URLs", () => {
    expect(
      slackWorkspaceOriginFromUrl(
        "https://team.slack.com/archives/C123/p1700000000000000?thread_ts=1700000000.000000",
      ),
    ).toBe("https://team.slack.com");
    expect(slackWorkspaceOriginFromUrl("https://agency.slack-gov.com/docs/T123/F12345678")).toBe(
      "https://agency.slack-gov.com",
    );
  });

  test("selects the matching browser app origin for each Slack realm", () => {
    expect(slackAppOriginForWorkspace("https://team.slack.com")).toBe("https://app.slack.com");
    expect(slackAppOriginForWorkspace("https://agency.slack-gov.com")).toBe(
      "https://app.slack-gov.com",
    );
  });
});

describe("workspace credential schema", () => {
  const auth = {
    auth_type: "browser" as const,
    xoxc_token: "xoxc-test",
    xoxd_cookie: "xoxd-test",
  };

  test("canonicalizes imported Slack and GovSlack workspace origins", () => {
    expect(
      WorkspaceSchema.parse({
        workspace_url: "https://TEAM.slack.com/",
        auth,
      }).workspace_url,
    ).toBe("https://team.slack.com");
    expect(
      CredentialsSchema.parse({
        version: 1,
        default_workspace_url: "https://agency.slack-gov.com/",
        workspaces: [],
      }).default_workspace_url,
    ).toBe("https://agency.slack-gov.com");
  });

  test("rejects unsafe imported and default workspace origins", () => {
    expect(
      WorkspaceSchema.safeParse({
        workspace_url: "https://team.slack.com.evil.test",
        auth,
      }).success,
    ).toBe(false);
    expect(
      CredentialsSchema.safeParse({
        version: 1,
        default_workspace_url: "http://team.slack.com",
        workspaces: [],
      }).success,
    ).toBe(false);
  });

  test("refuses a mixed valid and unsafe stored document instead of replacing it", () => {
    expect(() =>
      parseStoredCredentials({
        version: 1,
        workspaces: [
          {
            workspace_url: "https://team.slack.com",
            auth,
          },
          {
            workspace_url: "http://legacy.slack.com",
            auth,
          },
        ],
      }),
    ).toThrow("refusing to use or overwrite");
  });

  test("refuses malformed or null credential files without changing them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-credentials-"));
    const credentialsFile = join(dir, "credentials.json");
    try {
      for (const raw of ["{not-json", "null\n"]) {
        await writeFile(credentialsFile, raw);
        await expect(readStoredCredentials(credentialsFile)).rejects.toThrow(
          "refusing to use or overwrite",
        );
        expect(await readFile(credentialsFile, "utf8")).toBe(raw);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("uses distinct keychain cookie accounts for each workspace and realm", () => {
    expect(browserCookieAccount("https://team.slack.com")).toBe("xoxd:https://team.slack.com");
    expect(browserCookieAccount("https://agency.slack-gov.com")).toBe(
      "xoxd:https://agency.slack-gov.com",
    );
  });
});
