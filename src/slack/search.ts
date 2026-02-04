import type { SlackApiClient, SlackAuth } from "./client.ts";
import type { CompactSlackMessage } from "./messages.ts";
import { buildSlackSearchQuery } from "./search-query.ts";
import { searchFilesRaw, searchMessagesRaw } from "./search-raw.ts";
import { searchFilesInChannelsFallback, searchFilesViaSearchApi } from "./search-files.ts";
import { searchMessagesInChannelsFallback, searchMessagesViaSearchApi } from "./search-messages.ts";

export type SearchKind = "messages" | "files" | "all";
export type ContentType = "any" | "text" | "image" | "snippet" | "file";

export type SearchOptions = {
  workspace_url?: string;
  query: string;
  kind: SearchKind;
  channels?: string[];
  user?: string; // @name, name, or U...
  after?: string; // YYYY-MM-DD
  before?: string; // YYYY-MM-DD
  content_type?: ContentType;
  limit?: number;
  max_content_chars?: number;
  download?: boolean;
};

export type SearchResult = {
  messages?: Omit<CompactSlackMessage, "channel_id" | "thread_ts">[];
  files?: { title?: string; mimetype?: string; mode?: string; path: string }[];
};

export async function searchSlack(input: {
  client: SlackApiClient;
  auth: SlackAuth;
  options: SearchOptions;
}): Promise<SearchResult> {
  const limit = Math.min(Math.max(input.options.limit ?? 20, 1), 200);
  const maxContentChars = input.options.max_content_chars ?? 4000;
  const contentType = input.options.content_type ?? "any";
  const download = input.options.download ?? true;
  if (!download && (input.options.kind === "files" || input.options.kind === "all")) {
    throw new Error("File search requires downloads enabled (so agents get local file paths).");
  }

  const slackQuery = await buildSlackSearchQuery(input.client, {
    query: input.options.query,
    channels: input.options.channels,
    user: input.options.user,
    after: input.options.after,
    before: input.options.before,
  });

  const out: SearchResult = {};

  if (input.options.kind === "messages" || input.options.kind === "all") {
    if (input.options.channels?.length) {
      out.messages = await searchMessagesInChannelsFallback(input.client, {
        auth: input.auth,
        query: input.options.query,
        channels: input.options.channels,
        user: input.options.user,
        after: input.options.after,
        before: input.options.before,
        limit,
        maxContentChars,
        contentType,
        download,
      });
    } else {
      const rawMatches = await searchMessagesRaw(input.client, { query: slackQuery, limit });
      out.messages = await searchMessagesViaSearchApi(input.client, {
        auth: input.auth,
        workspace_url: input.options.workspace_url,
        slack_query: slackQuery,
        limit,
        maxContentChars,
        contentType,
        download,
        rawMatches,
      });
    }
  }

  if (input.options.kind === "files" || input.options.kind === "all") {
    if (input.options.channels?.length) {
      out.files = await searchFilesInChannelsFallback(input.client, {
        auth: input.auth,
        query: input.options.query,
        channels: input.options.channels,
        user: input.options.user,
        after: input.options.after,
        before: input.options.before,
        limit,
        contentType,
      });
    } else {
      const rawMatches = await searchFilesRaw(input.client, { query: slackQuery, limit });
      out.files = await searchFilesViaSearchApi(input.client, {
        auth: input.auth,
        slack_query: slackQuery,
        limit,
        contentType,
        rawMatches,
      });
    }
  }

  return out;
}
