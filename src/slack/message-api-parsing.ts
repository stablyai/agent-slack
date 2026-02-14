import type { SlackApiClient } from "./client.ts";
import type { SlackFileSummary } from "./messages.ts";
import { getNumber, getString, isRecord } from "../lib/object-type-guards.ts";

export function toSlackFileSummary(value: unknown): SlackFileSummary | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = getString(value.id);
  if (!id) {
    return null;
  }
  return {
    id,
    name: getString(value.name),
    title: getString(value.title),
    mimetype: getString(value.mimetype),
    filetype: getString(value.filetype),
    mode: getString(value.mode),
    permalink: getString(value.permalink),
    url_private: getString(value.url_private),
    url_private_download: getString(value.url_private_download),
    size: getNumber(value.size),
  };
}

export async function enrichFiles(
  client: SlackApiClient,
  files: SlackFileSummary[],
): Promise<SlackFileSummary[]> {
  const out: SlackFileSummary[] = [];
  for (const f of files) {
    if (f.mode === "snippet" || !f.url_private_download) {
      try {
        const info = await client.api("files.info", { file: f.id });
        const file = isRecord(info.file) ? info.file : null;
        out.push({
          ...f,
          name: f.name ?? getString(file?.name),
          title: f.title ?? getString(file?.title),
          mimetype: f.mimetype ?? getString(file?.mimetype),
          filetype: f.filetype ?? getString(file?.filetype),
          mode: f.mode ?? getString(file?.mode),
          permalink: f.permalink ?? getString(file?.permalink),
          url_private: f.url_private ?? getString(file?.url_private),
          url_private_download: f.url_private_download ?? getString(file?.url_private_download),
          snippet: {
            content: getString(file?.content),
            language: getString(file?.filetype),
          },
        });
        continue;
      } catch {
        // ignore and fall back to summary
      }
    }
    out.push(f);
  }
  return out;
}
