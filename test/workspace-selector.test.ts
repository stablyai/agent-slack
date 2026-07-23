import { describe, expect, test } from "bun:test";
import type { Workspace } from "../src/auth/schema.ts";
import { resolveWorkspaceSelector } from "../src/cli/workspace-selector.ts";

function browserWorkspace(input: {
  url: string;
  workspace_name?: string;
  team_domain?: string;
}): Workspace {
  return {
    workspace_url: input.url,
    workspace_name: input.workspace_name,
    team_domain: input.team_domain,
    auth: {
      auth_type: "browser",
      xoxc_token: "xoxc-test",
      xoxd_cookie: "xoxd-test",
    },
  };
}

describe("resolveWorkspaceSelector", () => {
  const workspaces: Workspace[] = [
    browserWorkspace({
      url: "https://stablygroup.slack.com",
      workspace_name: "Stably Group",
      team_domain: "stablygroup",
    }),
    browserWorkspace({
      url: "https://stablylabs.slack.com",
      workspace_name: "Stably Labs",
      team_domain: "stablylabs",
    }),
    browserWorkspace({ url: "https://acme.slack.com", workspace_name: "Acme" }),
    browserWorkspace({
      url: "https://agency.slack-gov.com",
      workspace_name: "Agency",
      team_domain: "agency",
    }),
  ];

  test("matches exact URL", () => {
    const result = resolveWorkspaceSelector(workspaces, "https://stablygroup.slack.com");
    expect(result.match?.workspace_url).toBe("https://stablygroup.slack.com");
    expect(result.ambiguous).toHaveLength(0);
  });

  test("matches unique substring by host/team", () => {
    const result = resolveWorkspaceSelector(workspaces, "acme");
    expect(result.match?.workspace_url).toBe("https://acme.slack.com");
    expect(result.ambiguous).toHaveLength(0);
  });

  test("matches unique substring by workspace name", () => {
    const result = resolveWorkspaceSelector(workspaces, "group");
    expect(result.match?.workspace_url).toBe("https://stablygroup.slack.com");
    expect(result.ambiguous).toHaveLength(0);
  });

  test("matches GovSlack by exact URL and unique substring", () => {
    expect(
      resolveWorkspaceSelector(workspaces, "https://agency.slack-gov.com").match?.workspace_url,
    ).toBe("https://agency.slack-gov.com");
    expect(resolveWorkspaceSelector(workspaces, "agency").match?.workspace_url).toBe(
      "https://agency.slack-gov.com",
    );
  });

  test("returns ambiguity when selector matches multiple workspaces", () => {
    const result = resolveWorkspaceSelector(workspaces, "stably");
    expect(result.match).toBeNull();
    expect(result.ambiguous.map((w) => w.workspace_url).sort()).toEqual([
      "https://stablygroup.slack.com",
      "https://stablylabs.slack.com",
    ]);
  });

  test("returns no match when selector does not match", () => {
    const result = resolveWorkspaceSelector(workspaces, "does-not-exist");
    expect(result.match).toBeNull();
    expect(result.ambiguous).toHaveLength(0);
  });

  test("rejects unsafe URL selectors", () => {
    for (const selector of [
      "http://acme.slack.com",
      "https://acme.slack.com.evil.test",
      "https://user@acme.slack.com",
      "https://acme.slack.com:8443",
    ]) {
      expect(() => resolveWorkspaceSelector(workspaces, selector), selector).toThrow(
        "canonical HTTPS Slack or GovSlack origin",
      );
    }
  });

  test("ignores unsafe configured workspace candidates", () => {
    const unsafe = browserWorkspace({
      url: "https://acme.slack.com.evil.test",
      workspace_name: "Unsafe",
      team_domain: "unsafe",
    });
    expect(resolveWorkspaceSelector([unsafe], "unsafe").match).toBeNull();
  });
});
