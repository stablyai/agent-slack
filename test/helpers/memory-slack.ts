import { SlackApiClient, type SlackAuth } from "../../src/slack/client.ts";
import { webApiPlatformError } from "./web-api-platform-error.ts";

export type MemoryChannel = {
  id: string;
  name: string;
  kind: "public_channel" | "private_channel" | "im";
  state: "active" | "archived";
};

export type MemorySlack = {
  channels: MemoryChannel[];
  joinedChannelIds: Set<string>;
  search: "available" | "missing_scope";
  nameListing: "allowed" | "enterprise_restricted";
  joinScope: "granted" | "missing" | "missing_unnamed";
  /** An error Slack answers every join with, standing in for workspace and org policy. */
  joinRefusal: string | undefined;
};

type SlackJson = Record<string, unknown>;

export function memorySlack(overrides: Partial<MemorySlack> = {}): MemorySlack {
  return {
    channels: [
      { id: "C0GENERAL1", name: "general", kind: "public_channel", state: "active" },
      { id: "C0ARCHIVE1", name: "old-launch", kind: "public_channel", state: "archived" },
      { id: "G0PRIVATE1", name: "leads", kind: "private_channel", state: "active" },
      { id: "D0DIRECT01", name: "", kind: "im", state: "active" },
    ],
    joinedChannelIds: new Set(),
    search: "available",
    nameListing: "allowed",
    joinScope: "granted",
    joinRefusal: undefined,
    ...overrides,
  };
}

function memorySlackResponse(
  slack: MemorySlack,
  request: { method: string; params: SlackJson },
): SlackJson {
  const { method, params } = request;
  if (method === "search.messages") {
    if (slack.search === "missing_scope") {
      return { ok: false, error: "missing_scope", needed: "search:read" };
    }
    const name = String(params.query).replace(/^in:#/, "");
    const matches = slack.channels
      .filter((c) => c.name === name)
      .map((c) => ({ channel: { id: c.id, name: c.name } }));
    return { ok: true, messages: { matches } };
  }
  if (method === "conversations.list") {
    if (slack.nameListing === "enterprise_restricted") {
      return { ok: false, error: "enterprise_is_restricted" };
    }
    const types = String(params.types ?? "public_channel").split(",");
    const excludeArchived = String(params.exclude_archived) === "true";
    const channels = slack.channels
      .filter((c) => types.includes(c.kind))
      .filter((c) => !excludeArchived || c.state === "active")
      .map((c) => ({ id: c.id, name: c.name, is_archived: c.state === "archived" }));
    return { ok: true, channels, response_metadata: { next_cursor: "" } };
  }
  if (method === "conversations.join") {
    return memorySlackJoin(slack, String(params.channel));
  }
  return { ok: false, error: "unknown_method" };
}

function memorySlackJoin(slack: MemorySlack, channelId: string): SlackJson {
  if (slack.joinScope === "missing") {
    return { ok: false, error: "missing_scope", needed: "channels:write", provided: "chat:write" };
  }
  if (slack.joinScope === "missing_unnamed") {
    return { ok: false, error: "missing_scope" };
  }
  if (slack.joinRefusal) {
    return { ok: false, error: slack.joinRefusal };
  }
  const channel = slack.channels.find((c) => c.id === channelId);
  if (!channel) {
    return { ok: false, error: "channel_not_found" };
  }
  if (channel.kind !== "public_channel") {
    return { ok: false, error: "method_not_supported_for_channel_type" };
  }
  if (channel.state === "archived") {
    return { ok: false, error: "is_archived" };
  }
  const slackChannel = { id: channel.id, name: channel.name, is_channel: true, is_member: true };
  if (slack.joinedChannelIds.has(channelId)) {
    return {
      ok: true,
      channel: slackChannel,
      warning: "already_in_channel",
      response_metadata: { warnings: ["already_in_channel"] },
    };
  }
  slack.joinedChannelIds.add(channelId);
  return { ok: true, channel: slackChannel };
}

/** Answers like `WebClient.apiCall`: the response, or a thrown platform error. */
function standardTokenClient(slack: MemorySlack): SlackApiClient {
  const client = {
    api: async (method: string, params: SlackJson = {}) => {
      const result = memorySlackResponse(slack, { method, params });
      if (result.ok !== true) {
        throw webApiPlatformError(result);
      }
      return result;
    },
  };
  return client as unknown as SlackApiClient;
}

/** The real browser-auth client, talking HTTP to the in-memory workspace. */
function browserClient(slack: MemorySlack): SlackApiClient {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = new URL(String(url)).pathname.replace(/^\/api\//, "");
    const params = Object.fromEntries(new URLSearchParams(String(init?.body)));
    return new Response(JSON.stringify(memorySlackResponse(slack, { method, params })), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return new SlackApiClient(
    { auth_type: "browser", xoxc_token: "xoxc-test", xoxd_cookie: "xoxd-test" },
    { workspaceUrl: "https://workspace.slack.com" },
  );
}

export const transports: {
  auth: SlackAuth;
  client: (slack: MemorySlack) => SlackApiClient;
  /** How the CLI prints the Slack error that caused a failure. */
  slackError: (code: string) => string;
}[] = [
  {
    auth: { auth_type: "standard", token: "xoxp-test" },
    client: standardTokenClient,
    slackError: (code) => `An API error occurred: ${code}`,
  },
  {
    auth: { auth_type: "browser", xoxc_token: "xoxc-test", xoxd_cookie: "xoxd-test" },
    client: browserClient,
    slackError: (code) => code,
  },
];
