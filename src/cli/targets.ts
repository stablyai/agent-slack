import { parseSlackMessageUrl, type SlackMessageRef } from "../slack/url.ts";
import { isChannelId } from "../slack/channels.ts";
import { isUserId } from "../slack/user-id.ts";

export type MsgTarget =
  | { kind: "url"; ref: SlackMessageRef }
  | { kind: "channel"; channel: string }
  | { kind: "user"; userId: string };

export function parseMsgTarget(input: string): MsgTarget {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Missing target");
  }

  try {
    const ref = parseSlackMessageUrl(trimmed);
    return { kind: "url", ref };
  } catch {
    // not a slack message URL
  }

  if (isUserId(trimmed)) {
    return { kind: "user", userId: trimmed };
  }
  if (trimmed.startsWith("#")) {
    return { kind: "channel", channel: trimmed };
  }
  if (isChannelId(trimmed)) {
    return { kind: "channel", channel: trimmed };
  }

  // Allow bare channel names ("general") for convenience.
  return { kind: "channel", channel: `#${trimmed}` };
}

/** The channel a channel command acts on, and the workspace selector that goes with it. */
export type ChannelTarget =
  | { kind: "url"; channel: string; workspace: string; messageTs: string }
  | { kind: "channel"; channel: string; workspace: string | undefined };

/**
 * The channel named by a command's target argument: a message URL, which also names its
 * workspace and so rejects `--workspace`, or a channel ID or name, which takes `--workspace`.
 */
export function channelTarget(input: {
  target: string;
  workspace: string | undefined;
  command: string;
}): ChannelTarget {
  const target = parseMsgTarget(input.target);
  switch (target.kind) {
    case "url":
      if (input.workspace) {
        throw new Error(
          "--workspace cannot be used with a URL target; the workspace is derived from the URL",
        );
      }
      return {
        kind: "url",
        channel: target.ref.channel_id,
        workspace: target.ref.workspace_url,
        messageTs: target.ref.message_ts,
      };
    case "channel":
      return { kind: "channel", channel: target.channel, workspace: input.workspace };
    case "user":
      throw new Error(`User targets are not supported for ${input.command}`);
  }
}
