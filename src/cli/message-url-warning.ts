export function warnOnTruncatedSlackUrl(ref: { possiblyTruncated?: boolean }): void {
  if (ref.possiblyTruncated) {
    console.error(
      'Hint: URL may have been truncated by shell. Quote URLs containing "&":\n' +
        '  agent-slack message get "https://...?thread_ts=...&cid=..."',
    );
  }
}

const MARKDOWN_LINK_RE = /(^|[^!\\])\[[^\]\n]+\]\((?:https?:\/\/|mailto:)[^\s)]+/i;

/** Warn when message text appears to use unsupported Markdown link syntax. */
export function warnOnMarkdownLinkSyntax(text: string): void {
  if (MARKDOWN_LINK_RE.test(text)) {
    process.stderr.write(
      "Warning: Markdown-style links are not converted. Use Slack link syntax: <https://example.com|label>.\n",
    );
  }
}
