/**
 * Prepare user-authored text for Slack's `chat.postMessage` / `chat.update`.
 *
 * Slack's mrkdwn contract requires:
 *  - literal `&`, `<`, `>` escaped as `&amp;`, `&lt;`, `&gt;`
 *  - user mentions wrapped as `<@U123>`, channel mentions as `<#C123>`,
 *    broadcast mentions as `<!here>` / `<!channel>` / `<!everyone>`
 *
 * Humans (and LLMs piping text into the CLI) commonly write `@U123` and
 * raw `&`/`<`/`>` — this helper normalizes that to what Slack expects,
 * while leaving already-well-formed Slack tokens intact.
 */
export function formatOutboundSlackText(text: string): string {
  if (!text) {
    return "";
  }

  // Protect already-formatted Slack tokens so `<`/`>` inside them aren't escaped.
  const stash: string[] = [];
  let out = text.replace(
    /<(?:@[UWB][A-Z0-9]+(?:\|[^>]*)?|#[CG][A-Z0-9]+(?:\|[^>]*)?|![a-zA-Z]+(?:\|[^>]*)?|https?:\/\/[^>]+)>/g,
    (m) => {
      stash.push(m);
      return `\u0000${stash.length - 1}\u0000`;
    },
  );

  // Escape literal HTML-ish characters per Slack's mrkdwn rules.
  out = out.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Promote bare user IDs (`@U05BRPTKL6A`) to real mentions.
  out = out.replace(/(^|[^A-Za-z0-9_])@([UWB][A-Z0-9]{6,})\b/g, (_m, pre, id) => `${pre}<@${id}>`);

  // Promote broadcast mentions.
  out = out.replace(
    /(^|[^A-Za-z0-9_])@(here|channel|everyone)\b/g,
    (_m, pre, name) => `${pre}<!${name}>`,
  );

  // Restore protected tokens.
  out = out.replace(/\u0000(\d+)\u0000/g, (_m, idx) => stash[Number(idx)]!);

  return out;
}
