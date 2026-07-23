import { slackRealmForUrl, type SlackRealm } from "../slack/workspace-url.ts";

export function requireSingleSlackRealm(teams: { url: string }[]): SlackRealm {
  const realms = new Set(teams.map((team) => slackRealmForUrl(team.url)));
  if (realms.size !== 1) {
    throw new Error(
      "Cannot import Slack and GovSlack browser sessions together. " +
        "Use a browser profile or desktop installation containing one Slack realm at a time.",
    );
  }
  return realms.values().next().value!;
}

export function slackCookieHostCondition(column: "host" | "host_key", realm: SlackRealm): string {
  const domain = realm === "gov" ? "slack-gov.com" : "slack.com";
  return `(${column} = '${domain}' or ${column} like '%.${domain}')`;
}
