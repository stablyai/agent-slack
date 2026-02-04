import type { SlackApiClient } from "./client.ts";
import { asArray, isRecord } from "./search-guards.ts";

export async function searchMessagesRaw(
  client: SlackApiClient,
  input: { query: string; limit: number },
): Promise<Record<string, unknown>[]> {
  const pageSize = Math.min(Math.max(input.limit, 1), 100);
  const out: Record<string, unknown>[] = [];
  let page = 1;
  let pages = 1;

  for (;;) {
    const resp = await client.api("search.messages", {
      query: input.query,
      count: pageSize,
      page,
      highlight: false,
      sort: "timestamp",
      sort_dir: "desc",
    });
    const messages = isRecord(resp) ? resp.messages : null;
    const matches = isRecord(messages) ? asArray(messages.matches).filter(isRecord) : [];
    out.push(...matches);

    const paging = isRecord(messages) ? (messages.paging ?? messages.pagination) : null;
    const totalPages = Number(isRecord(paging) ? (paging.pages ?? 1) : 1);
    if (Number.isFinite(totalPages) && totalPages > 0) {
      pages = totalPages;
    }

    if (out.length >= input.limit) {
      break;
    }
    if (matches.length === 0) {
      break;
    }
    if (page >= pages) {
      break;
    }
    page++;
  }

  return out.slice(0, input.limit);
}

export async function searchFilesRaw(
  client: SlackApiClient,
  input: { query: string; limit: number },
): Promise<Record<string, unknown>[]> {
  const pageSize = Math.min(Math.max(input.limit, 1), 100);
  const out: Record<string, unknown>[] = [];
  let page = 1;
  let pages = 1;

  for (;;) {
    const resp = await client.api("search.files", {
      query: input.query,
      count: pageSize,
      page,
      highlight: false,
      sort: "timestamp",
      sort_dir: "desc",
    });
    const files = isRecord(resp) ? resp.files : null;
    const matches = isRecord(files) ? asArray(files.matches).filter(isRecord) : [];
    out.push(...matches);

    const paging = isRecord(files) ? (files.paging ?? files.pagination) : null;
    const totalPages = Number(isRecord(paging) ? (paging.pages ?? 1) : 1);
    if (Number.isFinite(totalPages) && totalPages > 0) {
      pages = totalPages;
    }

    if (out.length >= input.limit) {
      break;
    }
    if (matches.length === 0) {
      break;
    }
    if (page >= pages) {
      break;
    }
    page++;
  }

  return out.slice(0, input.limit);
}
