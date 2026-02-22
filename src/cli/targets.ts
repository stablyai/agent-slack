import { parseSlackMessageUrl, type SlackMessageRef } from "../slack/url.ts";
import { isChannelId, isUserId } from "../slack/channels.ts";

export type MsgTarget =
  | { kind: "url"; ref: SlackMessageRef }
  | { kind: "channel"; channel: string }
  | { kind: "user"; userId: string };

export function assertNotUserTarget(
  target: MsgTarget,
  command: string,
): asserts target is Exclude<MsgTarget, { kind: "user" }> {
  if (target.kind === "user") {
    throw new Error(
      `${command} does not support user ID targets. To interact with DMs, send a message first via 'message send ${target.userId} "text"', then use the DM channel ID or message URL.`,
    );
  }
}

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
