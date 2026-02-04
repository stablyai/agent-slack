export type ParsedCurlTokens = {
  workspace_url: string;
  xoxc_token: string;
  xoxd_cookie: string;
};

export function parseSlackCurlCommand(curlInput: string): ParsedCurlTokens {
  const urlMatch = curlInput.match(/curl\s+['"]?(https?:\/\/([^.]+)\.slack\.com[^'"\s]*)/i);
  if (!urlMatch) {
    throw new Error("Could not find Slack workspace URL in cURL command");
  }
  const workspace_url = `https://${urlMatch[2]}.slack.com`;

  const cookieMatch = curlInput.match(
    /(?:-b|--cookie)\s+\$?'([^']+)'|(?:-b|--cookie)\s+\$?"([^"]+)"|-H\s+\$?'[Cc]ookie:\s*([^']+)'|-H\s+\$?"[Cc]ookie:\s*([^"]+)"/,
  );
  const cookieHeader = cookieMatch
    ? cookieMatch[1] || cookieMatch[2] || cookieMatch[3] || cookieMatch[4] || ""
    : "";
  const xoxdMatch = cookieHeader.match(/(?:^|;\s*)d=(xoxd-[^;]+)/);
  if (!xoxdMatch) {
    throw new Error("Could not find xoxd cookie (d=xoxd-...) in cURL command");
  }
  const xoxd_cookie = decodeURIComponent(xoxdMatch[1]!);

  // Token can appear in various forms: token=..., "token":"...", or name="token"... in form bodies.
  // Try common patterns first, then fall back to the first xoxc-* we can find.
  const tokenPatterns: RegExp[] = [
    /(?:^|[?&\s])token=(xoxc-[A-Za-z0-9-]+)/,
    /"token"\s*:\s*"(xoxc-[A-Za-z0-9-]+)"/,
    /name="token"[^x]*?(xoxc-[A-Za-z0-9-]+)/,
    /\b(xoxc-[A-Za-z0-9-]+)\b/,
  ];

  let xoxc_token: string | null = null;
  for (const re of tokenPatterns) {
    const m = curlInput.match(re);
    if (m?.[1]) {
      const [, token] = m;
      xoxc_token = token ?? null;
      break;
    }
  }
  if (!xoxc_token) {
    throw new Error("Could not find xoxc token in cURL command");
  }

  return { workspace_url, xoxc_token, xoxd_cookie };
}
