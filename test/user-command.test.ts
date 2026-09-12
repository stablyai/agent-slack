import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Command } from "commander";
import type { CliContext } from "../src/cli/context.ts";
import { registerUserCommand } from "../src/cli/user-command.ts";
import type { SlackApiClient } from "../src/slack/client.ts";

const originalLog = console.log;
const originalError = console.error;
let logs: string[];
let errors: string[];

beforeEach(() => {
  logs = [];
  errors = [];
  process.exitCode = 0;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  process.exitCode = 0;
});

type Response = Error | Record<string, unknown>;

function user(id: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  const profile =
    fields.profile && typeof fields.profile === "object" && !Array.isArray(fields.profile)
      ? fields.profile
      : {};
  return {
    id,
    deleted: false,
    is_bot: false,
    ...fields,
    profile: { ...profile },
  };
}

function clientFor(
  responses: Response[],
  calls: { method: string; params: Record<string, unknown> }[] = [],
): SlackApiClient {
  const api = async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    const response = responses.shift();
    if (!response || response instanceof Error) {
      throw response ?? new Error("Missing response");
    }
    return response;
  };
  return {
    api,
    lookupUserByEmail: (email: string) => api("users.lookupByEmail", { email }),
  } as unknown as SlackApiClient;
}

function context(client: SlackApiClient, overrides: Partial<CliContext> = {}): CliContext {
  return {
    effectiveWorkspaceUrl: (workspace) => workspace,
    withAutoRefresh: async <T>(input: { work: () => Promise<T> }) => input.work(),
    getClientForWorkspace: async () => ({
      client,
      auth: { auth_type: "standard", token: "x" },
      workspace_url: "https://workspace.slack.com",
    }),
    ...overrides,
  } as CliContext;
}

async function runResolve(ctx: CliContext, ...args: string[]): Promise<void> {
  const program = new Command();
  registerUserCommand({ program, ctx });
  await program.parseAsync(["user", "resolve", ...args], { from: "user" });
}

describe("user resolve command", () => {
  test("auth refresh restarts the entire direct batch", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const client = clientFor(
      [
        { url: "https://agency.slack-gov.com/", team_id: "T11111111" },
        { user: user("U11111111") },
        new Error("invalid_auth"),
        { url: "https://agency.slack-gov.com/", team_id: "T11111111" },
        { user: user("U33333333") },
        { user: user("W22222222") },
      ],
      calls,
    );
    const ctx = context(client, {
      withAutoRefresh: async <T>(input: { work: () => Promise<T> }) => {
        try {
          return await input.work();
        } catch {
          return await input.work();
        }
      },
      getClientForWorkspace: async () => ({
        client,
        auth: { auth_type: "standard", token: "x" },
        workspace_url: "https://agency.slack-gov.com",
      }),
    });

    await runResolve(ctx, "alice@example.com", "W22222222");

    expect(calls).toEqual([
      { method: "auth.test", params: {} },
      { method: "users.lookupByEmail", params: { email: "alice@example.com" } },
      { method: "users.info", params: { user: "W22222222" } },
      { method: "auth.test", params: {} },
      { method: "users.lookupByEmail", params: { email: "alice@example.com" } },
      { method: "users.info", params: { user: "W22222222" } },
    ]);
    expect(JSON.parse(logs[0]!)).toMatchObject({
      workspace: "https://agency.slack-gov.com",
      safe_to_mention: true,
      results: [{ mention: "<@U33333333>" }, { mention: "<@W22222222>" }],
    });
    expect(logs[0]).not.toContain("U11111111");
  });

  test("uses a fixed generic error for request failures", async () => {
    await runResolve(context(clientFor([new Error("timeout <@U99999999>")])), "U11111111");

    expect(logs).toEqual([]);
    expect(errors).toEqual(["Unable to resolve users safely."]);
    expect(errors[0]).not.toContain("U99999999");
    expect(process.exitCode).toBe(1);
  });

  test("withholds mentions for an unsafe direct result", async () => {
    await runResolve(
      context(
        clientFor([
          { url: "https://workspace.slack.com/", team_id: "T11111111" },
          { user: user("U11111111", { deleted: true }) },
        ]),
      ),
      "U11111111",
    );

    expect(errors).toEqual([]);
    expect(JSON.parse(logs[0]!)).toEqual({
      workspace: "https://workspace.slack.com",
      safe_to_mention: false,
      results: [{ index: 0, status: "unresolved" }],
    });
    expect(logs[0]).not.toContain("<@");
    expect(process.exitCode).toBe(1);
  });

  test("validates a configured workspace before calling Slack", async () => {
    let apiCalls = 0;
    const client = { api: async () => apiCalls++ } as unknown as SlackApiClient;
    const badWorkspaces = [
      "http://workspace.slack.com",
      "https://collector.example",
      "https://workspace.slack.com/<@U99999999>",
    ];

    for (const workspace_url of badWorkspaces) {
      logs = [];
      errors = [];
      await runResolve(
        context(client, {
          getClientForWorkspace: async () => ({
            client,
            auth: { auth_type: "standard", token: "x" },
            workspace_url,
          }),
        }),
        "U11111111",
      );
      expect(logs).toEqual([]);
      expect(errors).toEqual(["Unable to resolve users safely."]);
    }
    expect(apiCalls).toBe(0);
  });

  test("rejects a selected workspace that does not match auth.test", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const client = clientFor([{ url: "https://actual.slack.com/", team_id: "T11111111" }], calls);

    await runResolve(
      context(client, {
        getClientForWorkspace: async () => ({
          client,
          auth: { auth_type: "standard", token: "x" },
          workspace_url: "https://selected.slack.com",
        }),
      }),
      "U11111111",
    );

    expect(calls).toEqual([{ method: "auth.test", params: {} }]);
    expect(logs).toEqual([]);
    expect(errors).toEqual(["Unable to resolve users safely."]);
    expect(process.exitCode).toBe(1);
  });

  test("rejects auth.test responses without a valid team or enterprise ID", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const client = clientFor([{ url: "https://workspace.slack.com/", team_id: "bad" }], calls);

    await runResolve(context(client), "U11111111");

    expect(calls).toEqual([{ method: "auth.test", params: {} }]);
    expect(logs).toEqual([]);
    expect(errors).toEqual(["Unable to resolve users safely."]);
    expect(process.exitCode).toBe(1);
  });

  test("uses the workspace proven by auth.test when none was configured", async () => {
    const client = clientFor([
      { url: "https://actual.slack.com/", team_id: "T11111111" },
      { user: user("U11111111") },
    ]);

    await runResolve(
      context(client, {
        getClientForWorkspace: async () => ({
          client,
          auth: { auth_type: "standard", token: "x" },
          workspace_url: undefined,
        }),
      }),
      "U11111111",
    );

    expect(JSON.parse(logs[0]!)).toMatchObject({
      workspace: "https://actual.slack.com",
      safe_to_mention: true,
    });
    expect(errors).toEqual([]);
  });

  test("rejects names without calling Slack", async () => {
    let apiCalls = 0;
    const client = { api: async () => apiCalls++ } as unknown as SlackApiClient;

    await runResolve(context(client), "Alice Smith");

    expect(apiCalls).toBe(0);
    expect(logs).toEqual([]);
    expect(errors).toEqual(["Unable to resolve users safely."]);
    expect(process.exitCode).toBe(1);
  });

  test("rejects an oversized batch before calling auth.test", async () => {
    let apiCalls = 0;
    const client = { api: async () => apiCalls++ } as unknown as SlackApiClient;

    await runResolve(
      context(client),
      ...Array.from({ length: 21 }, (_, index) => `person-${index}@example.com`),
    );

    expect(apiCalls).toBe(0);
    expect(logs).toEqual([]);
    expect(errors).toEqual(["Unable to resolve users safely."]);
    expect(process.exitCode).toBe(1);
  });
});
