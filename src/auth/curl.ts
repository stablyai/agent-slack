export type ParsedCurlTokens = {
  workspace_url: string;
  xoxc_token: string;
  xoxd_cookie: string;
};

export function parseSlackCurlCommand(curlInput: string): ParsedCurlTokens {
  const urlMatch = curlInput.match(
    /curl\s+'?(https?:\/\/([^.]+)\.slack\.com[^'"\s]*)/,
  );
  if (!urlMatch) {
    throw new Error("Could not find Slack workspace URL in cURL command");
  }
  const workspace_url = `https://${urlMatch[2]}.slack.com`;

  const cookieMatch = curlInput.match(
    /-b\s+'([^']+)'|--cookie\s+'([^']+)'|-H\s+'[Cc]ookie:\s*([^']+)'/,
  );
  const cookieHeader = cookieMatch
    ? cookieMatch[1] || cookieMatch[2] || cookieMatch[3] || ""
    : "";
  const xoxdMatch = cookieHeader.match(/(?:^|;\s*)d=(xoxd-[^;]+)/);
  if (!xoxdMatch)
    throw new Error("Could not find xoxd cookie (d=xoxd-...) in cURL command");
  const xoxd_cookie = decodeURIComponent(xoxdMatch[1]!);

  const dataMatch = curlInput.match(
    /--data-raw\s+\$?'([^']+)'|--data-raw\s+\$?"([^"]+)"|--data\s+\$?'([^']+)'|--data\s+\$?"([^"]+)"/,
  );
  const dataContent = dataMatch
    ? dataMatch[1] || dataMatch[2] || dataMatch[3] || dataMatch[4] || ""
    : "";
  const xoxcMatch = dataContent.match(/name="token".*?(xoxc-[a-zA-Z0-9-]+)/);
  if (!xoxcMatch) throw new Error("Could not find xoxc token in request data");
  const xoxc_token = xoxcMatch[1]!;

  return { workspace_url, xoxc_token, xoxd_cookie };
}
