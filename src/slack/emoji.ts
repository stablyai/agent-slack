import * as emoji from "node-emoji";

export function slackEmojiShortcodesToUnicode(text: string): string {
  if (!text) {
    return "";
  }
  // Prefer Slack-style emoji shortcodes (node-emoji) since Slack uses names
  // that don't always match other shortcode sets.
  return emoji.emojify(text);
}

export function normalizeSlackReactionName(input: string): string {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) {
    throw new Error("Emoji is empty");
  }

  // Accept :rocket:
  const shortcodeMatch = trimmed.match(/^:([^:\s]+):$/);
  if (shortcodeMatch) {
    return shortcodeMatch[1]!;
  }

  // Accept already-normalized names (rocket, +1, white_check_mark, etc.)
  if (/^[A-Za-z0-9_+-]+$/.test(trimmed)) {
    return trimmed;
  }

  // Accept unicode emoji (🚀). Convert to :rocket: then strip colons.
  const viaNodeEmoji = emoji.which(trimmed);
  if (viaNodeEmoji) {
    return viaNodeEmoji;
  }

  throw new Error(
    `Unsupported emoji format: ${JSON.stringify(input)} (use :emoji: or unicode emoji)`,
  );
}
