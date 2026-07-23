import { parseSlackMessageUrl, type SlackMessageRef } from "../slack/url.ts";
import { isChannelId } from "../slack/channels.ts";
import { isUserId } from "../slack/user-id.ts";

export type MsgTarget =
  | { kind: "url"; ref: SlackMessageRef }
  | { kind: "channel"; channel: string }
  | { kind: "user"; userId: string };

function isAbsoluteUrl(input: string): boolean {
  try {
    new URL(input);
    return true;
  } catch {
    return false;
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
  } catch (error) {
    if (isAbsoluteUrl(trimmed)) {
      throw error;
    }
    // Not a URL-shaped Slack message target.
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
