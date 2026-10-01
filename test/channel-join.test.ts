import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Command } from "commander";
import { registerChannelCommand } from "../src/cli/channel-command.ts";
import { cliContextFor } from "./helpers/cli-context.ts";
import { withEnvironment } from "./helpers/environment.ts";
import { memorySlack, transports, type MemorySlack } from "./helpers/memory-slack.ts";

const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalError = console.error;

describe.each(transports)("channel join with $auth.auth_type auth", (transport) => {
  let stdout: ReturnType<typeof mock>;
  let stderr: ReturnType<typeof mock>;

  beforeEach(() => {
    process.exitCode = 0;
    stdout = mock(() => {});
    stderr = mock(() => {});
    console.log = stdout as typeof console.log;
    console.error = stderr as typeof console.error;
  });

  afterEach(() => {
    process.exitCode = 0;
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
  });

  async function runJoin(slack: MemorySlack, ...args: string[]): Promise<void> {
    const program = new Command();
    const ctx = cliContextFor({ client: transport.client(slack), auth: transport.auth });
    registerChannelCommand({ program, ctx });
    await program.parseAsync(["channel", "join", ...args], { from: "user" });
  }

  function printedJson(): unknown {
    return JSON.parse(String(stdout.mock.calls[0]?.[0]));
  }

  const joinedGeneral = { channel: { id: "C0GENERAL1", name: "general" }, status: "joined" };

  test("joins a public channel by ID", async () => {
    const slack = memorySlack();

    await runJoin(slack, "C0GENERAL1");

    expect(printedJson()).toEqual(joinedGeneral);
    expect([...slack.joinedChannelIds]).toEqual(["C0GENERAL1"]);
    expect(process.exitCode).toBe(0);
  });

  test("succeeds without change when already a member", async () => {
    const slack = memorySlack({ joinedChannelIds: new Set(["C0GENERAL1"]) });

    await runJoin(slack, "C0GENERAL1");

    expect(printedJson()).toEqual({
      channel: { id: "C0GENERAL1", name: "general" },
      status: "already_in_channel",
    });
    expect([...slack.joinedChannelIds]).toEqual(["C0GENERAL1"]);
    expect(process.exitCode).toBe(0);
  });

  test("joins the channel of a message URL", async () => {
    const slack = memorySlack({ search: "missing_scope", nameListing: "enterprise_restricted" });

    await runJoin(slack, "https://workspace.slack.com/archives/C0GENERAL1/p1234567890123456");

    expect(printedJson()).toEqual(joinedGeneral);
    expect([...slack.joinedChannelIds]).toEqual(["C0GENERAL1"]);
  });

  test("rejects --workspace with a message URL", async () => {
    const slack = memorySlack();

    await runJoin(
      slack,
      "https://workspace.slack.com/archives/C0GENERAL1/p1234567890123456",
      "--workspace",
      "https://other.slack.com",
    );

    expect(stderr.mock.calls).toEqual([
      ["--workspace cannot be used with a URL target; the workspace is derived from the URL"],
    ]);
    expect([...slack.joinedChannelIds]).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test("rejects a user ID", async () => {
    const slack = memorySlack();

    await runJoin(slack, "U0ALICE001");

    expect(stderr.mock.calls).toEqual([["User targets are not supported for channel join"]]);
    expect([...slack.joinedChannelIds]).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test.each(["#general", "general"])("resolves the name %s through search", async (name) => {
    const slack = memorySlack({ nameListing: "enterprise_restricted" });

    await runJoin(slack, name);

    expect(printedJson()).toEqual(joinedGeneral);
    expect([...slack.joinedChannelIds]).toEqual(["C0GENERAL1"]);
  });

  test("resolves a name through the channel list when search is unavailable", async () => {
    const slack = memorySlack({ search: "missing_scope" });

    await runJoin(slack, "#general");

    expect(printedJson()).toEqual(joinedGeneral);
    expect([...slack.joinedChannelIds]).toEqual(["C0GENERAL1"]);
  });

  test("names an archived channel found through the channel list as archived", async () => {
    const slack = memorySlack({ search: "missing_scope" });

    await runJoin(slack, "old-launch");

    expect(stderr.mock.calls).toEqual([
      [`Cannot join C0ARCHIVE1: the channel is archived: ${transport.slackError("is_archived")}`],
    ]);
    expect([...slack.joinedChannelIds]).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test("prefers a live channel to an archived one with the same name", async () => {
    const slack = memorySlack({
      search: "missing_scope",
      channels: [
        { id: "C0OLDLAUNCH", name: "launch", kind: "public_channel", state: "archived" },
        { id: "C0NEWLAUNCH", name: "launch", kind: "public_channel", state: "active" },
      ],
    });

    await runJoin(slack, "#launch");

    expect(printedJson()).toEqual({
      channel: { id: "C0NEWLAUNCH", name: "launch" },
      status: "joined",
    });
    expect([...slack.joinedChannelIds]).toEqual(["C0NEWLAUNCH"]);
  });

  test("asks for an ID or URL where Enterprise Grid restricts name lookup", async () => {
    const slack = memorySlack({ search: "missing_scope", nameListing: "enterprise_restricted" });

    await runJoin(slack, "#general");

    expect(stderr.mock.calls).toEqual([
      [
        `Cannot look up #general: Enterprise Grid restricts channel name lookup for this token; pass the channel ID or a message URL instead: ${transport.slackError("enterprise_is_restricted")}`,
      ],
    ]);
    expect([...slack.joinedChannelIds]).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test("reports a name that matches no channel", async () => {
    const slack = memorySlack();

    await runJoin(slack, "#not-a-channel");

    expect(stderr.mock.calls).toEqual([["Could not resolve channel name: #not-a-channel"]]);
    expect([...slack.joinedChannelIds]).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test.each([
    {
      target: "C0MISSING1",
      slack: {},
      error: "channel_not_found",
      reason: "no such channel is visible in this workspace; check the ID and the workspace",
    },
    { target: "C0ARCHIVE1", slack: {}, error: "is_archived", reason: "the channel is archived" },
    {
      target: "G0PRIVATE1",
      slack: {},
      error: "method_not_supported_for_channel_type",
      reason: "only public channels can be joined; private channels and DMs need an invite",
    },
    {
      target: "D0DIRECT01",
      slack: {},
      error: "method_not_supported_for_channel_type",
      reason: "only public channels can be joined; private channels and DMs need an invite",
    },
    {
      target: "C0GENERAL1",
      slack: { joinScope: "missing" },
      error: "missing_scope",
      reason: "the token needs channels:write; it has chat:write",
    },
    {
      target: "C0GENERAL1",
      slack: { joinScope: "missing_unnamed" },
      error: "missing_scope",
      reason: "the token needs channels:write (user token) or channels:join (bot token)",
    },
    {
      target: "C0GENERAL1",
      slack: { joinRefusal: "enterprise_is_restricted" },
      error: "enterprise_is_restricted",
      reason:
        "Slack does not allow conversations.join from this Enterprise Grid org or token; join the channel in the Slack client",
    },
    {
      target: "C0GENERAL1",
      slack: { joinRefusal: "too_many_members" },
      error: "too_many_members",
      reason: "the channel has reached Slack's member limit",
    },
    {
      target: "C0GENERAL1",
      slack: { joinRefusal: "channel_is_limited_access" },
      error: "channel_is_limited_access",
      reason: "the channel is a private Salesforce record channel you have no access to",
    },
    {
      target: "C0GENERAL1",
      slack: { joinRefusal: "app_cannot_join_channel" },
      error: "app_cannot_join_channel",
      reason: "Slack does not let this app join the channel",
    },
    {
      target: "C0GENERAL1",
      slack: { joinRefusal: "team_access_not_granted" },
      error: "team_access_not_granted",
      reason: "the token has not been granted access to the channel's workspace",
    },
    {
      target: "C0GENERAL1",
      slack: { joinRefusal: "not_allowed_token_type" },
      error: "not_allowed_token_type",
      reason: "Slack does not accept this kind of token for conversations.join",
    },
    {
      target: "C0GENERAL1",
      slack: { joinRefusal: "org_login_required" },
      error: "org_login_required",
      reason:
        "the workspace is migrating to an Enterprise Grid org and is unavailable until that finishes",
    },
    {
      target: "C0GENERAL1",
      slack: { joinRefusal: "account_inactive" },
      error: "account_inactive",
      reason: "the token belongs to a deleted user or workspace",
    },
  ] satisfies { target: string; slack: Partial<MemorySlack>; error: string; reason: string }[])(
    "explains $error for $target",
    async ({ target, slack: overrides, error, reason }) => {
      const slack = memorySlack(overrides);

      await runJoin(slack, target);

      expect(stderr.mock.calls).toEqual([
        [`Cannot join ${target}: ${reason}: ${transport.slackError(error)}`],
      ]);
      expect(stdout.mock.calls).toEqual([]);
      expect([...slack.joinedChannelIds]).toEqual([]);
      expect(process.exitCode).toBe(1);
    },
  );

  test("passes other Slack errors through unchanged", async () => {
    const slack = memorySlack({ joinRefusal: "user_is_restricted" });

    await runJoin(slack, "C0GENERAL1");

    expect(stderr.mock.calls).toEqual([[transport.slackError("user_is_restricted")]]);
    expect([...slack.joinedChannelIds]).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test("joins in safe mode, which covers only message send, edit and delete", async () => {
    const slack = memorySlack();

    await withEnvironment({ AGENT_SLACK_SAFE_MODE: "1" }, () => runJoin(slack, "C0GENERAL1"));

    expect(printedJson()).toEqual(joinedGeneral);
    expect([...slack.joinedChannelIds]).toEqual(["C0GENERAL1"]);
  });
});
