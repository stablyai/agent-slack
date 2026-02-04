import { slackEmojiShortcodesToUnicode } from "./emoji.ts";

export function slackMrkdwnToMarkdown(text: string): string {
  if (!text) {
    return "";
  }

  // Links: <http://x|label> or <http://x>
  let out = text.replace(/<((https?:\/\/)[^>|]+)\|([^>]+)>/g, "[$3]($1)");
  out = out.replace(/<((https?:\/\/)[^>]+)>/g, "$1");

  // Channels: <#C123|name>
  out = out.replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1");

  // Users: <@U123> or <@U123|name>
  out = out.replace(/<@([A-Z0-9]+)\|([^>]+)>/g, "@$2");
  out = out.replace(/<@([A-Z0-9]+)>/g, "@$1");

  // Special mentions: <!here>, <!channel>, <!everyone>
  out = out.replace(/<!([a-zA-Z]+)>/g, "@$1");

  // Decode basic HTML entities Slack sometimes includes
  out = out.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

  // Prefer unicode emoji for token efficiency (e.g. 🚀 vs :rocket:)
  out = slackEmojiShortcodesToUnicode(out);

  return out;
}
