import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliContext } from "../src/cli/context.ts";
import { resolveSlackNativeDraftEndpoint } from "../src/cli/slack-native-draft-endpoint.ts";
import type { SlackApiClient, SlackAuth } from "../src/slack/client.ts";

const workspaceUrl = "https://workspace.slack.com";
const enterpriseUrl = "https://grid.enterprise.slack.com";
const browserAuth: SlackAuth = {
  auth_type: "browser",
  xoxc_token: "xoxc-test",
  xoxd_cookie: "xoxd-test",
};
const enterpriseBrowserAuth: SlackAuth = {
  auth_type: "browser",
  xoxc_token: "xoxc-enterprise-test",
  xoxd_cookie: "xoxd-test",
};

function createGridFixture(input?: {
  enterpriseUserId?: string;
  enterpriseTeamId?: string;
  identityUrl?: string;
  reuseWorkspaceAuth?: boolean;
}) {
  const calls: { client: "workspace" | "enterprise"; method: string }[] = [];
  const api =
    (client: "workspace" | "enterprise") =>
    async (method: string): Promise<Record<string, unknown>> => {
      calls.push({ client, method });
      if (method === "auth.test") {
        return client === "workspace"
          ? {
              ok: true,
              url: input?.identityUrl ?? `${workspaceUrl}/`,
              team_id: "T12345678",
              user_id: "U12345678",
            }
          : {
              ok: true,
              team_id: input?.enterpriseTeamId ?? "E12345678",
              user_id: input?.enterpriseUserId ?? "U12345678",
            };
      }
      if (method === "team.info") {
        return {
          ok: true,
          team: {
            id: "T12345678",
            enterprise_id: "E12345678",
            enterprise_domain: "grid",
          },
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    };
  const workspaceClient = { api: api("workspace") } as SlackApiClient;
  const enterpriseClient = { api: api("enterprise") } as SlackApiClient;
  const ctx = {
    getClientForWorkspace: async (selector, options) => {
      expect(selector).toBe(enterpriseUrl);
      expect(options?.excludeAuth).toBe(browserAuth);
      return {
        client: enterpriseClient,
        auth: input?.reuseWorkspaceAuth ? browserAuth : enterpriseBrowserAuth,
        workspace_url: enterpriseUrl,
      };
    },
  } as CliContext;
  return { calls, ctx, workspaceClient, enterpriseClient };
}

describe("resolveSlackNativeDraftEndpoint", () => {
  test("routes a child workspace through its verified Enterprise Grid organization", async () => {
    const fixture = createGridFixture();

    const endpoint = await resolveSlackNativeDraftEndpoint({
      ctx: fixture.ctx,
      client: fixture.workspaceClient,
      auth: browserAuth,
      workspaceUrl,
    });

    expect(endpoint.client).toBe(fixture.enterpriseClient);
    expect(endpoint.workspaceUrl).toBe(enterpriseUrl);
    expect(fixture.calls).toEqual([
      { client: "workspace", method: "auth.test" },
      { client: "workspace", method: "team.info" },
      { client: "enterprise", method: "auth.test" },
    ]);
  });

  test("rejects organization credentials for a different enterprise or user", async () => {
    const wrongEnterprise = createGridFixture({ enterpriseTeamId: "E99999999" });
    await expect(
      resolveSlackNativeDraftEndpoint({
        ctx: wrongEnterprise.ctx,
        client: wrongEnterprise.workspaceClient,
        auth: browserAuth,
        workspaceUrl,
      }),
    ).rejects.toThrow("do not match the target workspace's organization");

    const wrongUser = createGridFixture({ enterpriseUserId: "U99999999" });
    await expect(
      resolveSlackNativeDraftEndpoint({
        ctx: wrongUser.ctx,
        client: wrongUser.workspaceClient,
        auth: browserAuth,
        workspaceUrl,
      }),
    ).rejects.toThrow("do not belong to the same Slack user");
  });

  test("rejects credentials authenticated to a different workspace", async () => {
    const fixture = createGridFixture({ identityUrl: "https://other.slack.com/" });

    await expect(
      resolveSlackNativeDraftEndpoint({
        ctx: fixture.ctx,
        client: fixture.workspaceClient,
        auth: browserAuth,
        workspaceUrl,
      }),
    ).rejects.toThrow("workspace origin does not match");
    expect(fixture.calls).toEqual([{ client: "workspace", method: "auth.test" }]);
  });

  test("rejects reuse of child workspace browser credentials as organization auth", async () => {
    const fixture = createGridFixture({ reuseWorkspaceAuth: true });

    await expect(
      resolveSlackNativeDraftEndpoint({
        ctx: fixture.ctx,
        client: fixture.workspaceClient,
        auth: browserAuth,
        workspaceUrl,
      }),
    ).rejects.toThrow("require separate organization browser credentials");
    expect(fixture.calls).toEqual([
      { client: "workspace", method: "auth.test" },
      { client: "workspace", method: "team.info" },
    ]);
  });

  test("keeps standard auth and organization URLs on their selected endpoint", async () => {
    const fixture = createGridFixture();
    const standardAuth = { auth_type: "standard" as const, token: "xoxb-test" };

    const standard = await resolveSlackNativeDraftEndpoint({
      ctx: fixture.ctx,
      client: fixture.workspaceClient,
      auth: standardAuth,
      workspaceUrl,
    });
    const organization = await resolveSlackNativeDraftEndpoint({
      ctx: fixture.ctx,
      client: fixture.enterpriseClient,
      auth: browserAuth,
      workspaceUrl: enterpriseUrl,
    });

    expect(standard.client).toBe(fixture.workspaceClient);
    expect(organization.client).toBe(fixture.enterpriseClient);
    expect(fixture.calls).toHaveLength(0);
  });
});

describe("environment-backed Enterprise Grid resolution", () => {
  const resolverUrl = new URL("../src/cli/context-client-resolver.ts", import.meta.url).href;
  const endpointUrl = new URL("../src/cli/slack-native-draft-endpoint.ts", import.meta.url).href;

  test("the real resolver uses separately configured organization auth", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-slack-grid-resolver-"));
    try {
      const configDir = join(home, ".config", "agent-slack");
      await mkdir(configDir, { recursive: true });
      await writeFile(
        join(configDir, "credentials.json"),
        JSON.stringify({
          version: 1,
          workspaces: [
            {
              workspace_url: enterpriseUrl,
              auth: enterpriseBrowserAuth,
            },
          ],
        }),
      );
      const environmentBinding = await runResolverScript({
        home,
        script: `
          const { getClientForWorkspace } = await import(${JSON.stringify(resolverUrl)});
          const endpoint = await getClientForWorkspace(${JSON.stringify(enterpriseUrl)});
          console.log(JSON.stringify({ auth: endpoint.auth, workspaceUrl: endpoint.workspace_url }));
        `,
      });
      const credentialExclusion = await runResolverScript({
        home,
        script: `
          const { getClientForWorkspace } = await import(${JSON.stringify(resolverUrl)});
          const childAuth = { auth_type: "browser", xoxc_token: "xoxc-child-test", xoxd_cookie: "xoxd-test" };
          const endpoint = await getClientForWorkspace(${JSON.stringify(enterpriseUrl)}, { excludeAuth: childAuth });
          console.log(JSON.stringify({ auth: endpoint.auth, workspaceUrl: endpoint.workspace_url }));
        `,
        omitEnvironmentWorkspaceUrl: true,
      });

      for (const result of [environmentBinding, credentialExclusion]) {
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
          auth: enterpriseBrowserAuth,
          workspaceUrl: enterpriseUrl,
        });
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("the real resolver fails explicitly when no separate organization auth exists", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-slack-grid-resolver-"));
    try {
      const result = await runResolverScript({
        home,
        script: `
          const { getClientForWorkspace } = await import(${JSON.stringify(resolverUrl)});
          const { resolveSlackNativeDraftEndpoint } = await import(${JSON.stringify(endpointUrl)});
          const childAuth = { auth_type: "browser", xoxc_token: "xoxc-child-test", xoxd_cookie: "xoxd-test" };
          const workspaceClient = { api: async (method) => {
            if (method === "auth.test") return { ok: true, url: ${JSON.stringify(`${workspaceUrl}/`)}, team_id: "T12345678", user_id: "U12345678" };
            if (method === "team.info") return { ok: true, team: { id: "T12345678", enterprise_id: "E12345678", enterprise_domain: "grid" } };
            throw new Error("Unexpected method: " + method);
          } };
          try {
            await resolveSlackNativeDraftEndpoint({ ctx: { getClientForWorkspace }, client: workspaceClient, auth: childAuth, workspaceUrl: ${JSON.stringify(workspaceUrl)} });
            throw new Error("resolver unexpectedly accepted child credentials");
          } catch (error) {
            console.log(error instanceof Error ? error.message : String(error));
          }
        `,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        `Enterprise Grid native drafts require separate organization browser credentials for ${enterpriseUrl}`,
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

async function runResolverScript(input: {
  home: string;
  script: string;
  omitEnvironmentWorkspaceUrl?: boolean;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const { XDG_CONFIG_HOME: _ignoredConfigHome, ...inheritedEnv } = process.env;
  const env = {
    ...inheritedEnv,
    HOME: input.home,
    SLACK_TOKEN: "xoxc-child-test",
    SLACK_COOKIE_D: "xoxd-test",
    ...(input.omitEnvironmentWorkspaceUrl ? {} : { SLACK_WORKSPACE_URL: workspaceUrl }),
  };
  const child = Bun.spawn([process.execPath, "--eval", input.script], {
    cwd: process.cwd(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}
