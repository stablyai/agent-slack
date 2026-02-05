export type SlackMessageRef = {
  workspace_url: string;
  channel_id: string;
  message_ts: string; // "1234567890.123456"
  thread_ts_hint?: string; // from URL query (?thread_ts=...)
  raw: string;
  /** True if the URL looks like it may have been truncated by shell & interpretation */
  possiblyTruncated?: boolean;
};

export function parseSlackMessageUrl(input: string): SlackMessageRef {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Invalid URL: ${input}`);
  }

  if (!/\.slack\.com$/i.test(url.hostname)) {
    throw new Error(`Not a Slack workspace URL: ${url.hostname}`);
  }

  const parts = url.pathname.split("/").filter(Boolean);
  // /archives/<channel>/p<digits>
  if (parts.length < 3 || parts[0] !== "archives") {
    throw new Error(`Unsupported Slack URL path: ${url.pathname}`);
  }

  const channel_id = parts[1]!;
  const messagePart = parts[2]!;
  const match = messagePart.match(/^p(\d{7,})$/);
  if (!match) {
    throw new Error(`Unsupported Slack message id: ${messagePart}`);
  }

  const digits = match[1]!;
  if (digits.length <= 6) {
    throw new Error(`Invalid Slack message id: ${messagePart}`);
  }
  const seconds = digits.slice(0, -6);
  const micros = digits.slice(-6);
  const message_ts = `${seconds}.${micros}`;

  const threadTsParam = url.searchParams.get("thread_ts");
  const thread_ts_hint =
    threadTsParam && /^\d{6,}\.\d{6}$/.test(threadTsParam) ? threadTsParam : undefined;

  // Slack URLs with thread_ts typically also have cid param. If thread_ts exists but
  // cid doesn't, the URL was likely truncated by shell interpreting & as background.
  const hasCid = url.searchParams.has("cid");
  const possiblyTruncated = Boolean(threadTsParam && !hasCid);

  const workspace_url = `${url.protocol}//${url.host}`;
  return { workspace_url, channel_id, message_ts, thread_ts_hint, raw: input, possiblyTruncated };
}
