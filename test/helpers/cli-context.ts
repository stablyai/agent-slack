import { errorMessage, type CliContext } from "../../src/cli/context.ts";
import type { SlackApiClient, SlackAuth } from "../../src/slack/client.ts";

/** A `CliContext` whose every workspace is served by `client`, printing errors as the CLI does. */
export function cliContextFor(input: { client: SlackApiClient; auth: SlackAuth }): CliContext {
  return {
    effectiveWorkspaceUrl: (flag?: string) => flag,
    assertWorkspaceSpecifiedForChannelNames: async () => {},
    withAutoRefresh: async <T>(refresh: {
      workspaceUrl: string | undefined;
      work: () => Promise<T>;
    }) => refresh.work(),
    getClientForWorkspace: async () => ({ client: input.client, auth: input.auth }),
    normalizeUrl: (u: string) => u,
    errorMessage,
    parseContentType: () => "any",
    parseCurl: (_curl: string) => ({
      workspace_url: "https://workspace.slack.com",
      xoxc_token: "xoxc-1",
      xoxd_cookie: "xoxd-1",
    }),
    importDesktop: async () => ({
      cookie_d: "",
      teams: [],
      source: { leveldb_path: "", cookies_path: "" },
    }),
    importChrome: () => ({ cookie_d: "", teams: [] }),
    importBrave: async () => null,
    importFirefox: async () => null,
  };
}
