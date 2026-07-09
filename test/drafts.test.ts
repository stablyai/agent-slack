import { describe, expect, test } from "bun:test";
import {
  createDraft,
  deleteDraft,
  draftTextToBlocks,
  findDraft,
  listDrafts,
  padDraftTs,
  parseDraftRecord,
  updateDraft,
} from "../src/slack/drafts.ts";
import type { SlackApiClient } from "../src/slack/client.ts";

function createClient(responses: Record<string, Record<string, unknown>>) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const client = {
    api: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      return responses[method] ?? { ok: true };
    },
  } as unknown as SlackApiClient;
  return { client, calls };
}

const rawDraft = {
  id: "Dr123",
  last_updated_ts: "1700000000.123",
  date_created: 1700000000,
  destinations: [{ channel_id: "C123", thread_ts: "1699.000100", broadcast: true }],
  blocks: [
    {
      type: "rich_text",
      elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "hello world" }] }],
    },
  ],
  file_ids: ["F1"],
  date_scheduled: 0,
};

describe("padDraftTs", () => {
  test("pads short fractional parts to 7 digits", () => {
    expect(padDraftTs("1700000000.123")).toBe("1700000000.1230000");
  });

  test("leaves 7-digit fractional parts unchanged", () => {
    expect(padDraftTs("1700000000.1234567")).toBe("1700000000.1234567");
  });

  test("leaves timestamps without a fractional part unchanged", () => {
    expect(padDraftTs("1700000000")).toBe("1700000000");
  });
});

describe("draftTextToBlocks", () => {
  test("wraps plain text in a rich_text section", () => {
    expect(draftTextToBlocks("hello world")).toEqual([
      {
        type: "rich_text",
        elements: [
          { type: "rich_text_section", elements: [{ type: "text", text: "hello world" }] },
        ],
      },
    ]);
  });

  test("converts bullet lists to rich_text lists", () => {
    const blocks = draftTextToBlocks("- one\n- two") as {
      type: string;
      elements: { type: string }[];
    }[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.elements.some((el) => el.type === "rich_text_list")).toBe(true);
  });
});

describe("parseDraftRecord", () => {
  test("parses a raw draft into a compact shape", () => {
    expect(parseDraftRecord(rawDraft)).toEqual({
      id: "Dr123",
      text: "hello world",
      destinations: [{ channel_id: "C123", thread_ts: "1699.000100", broadcast: true }],
      last_updated_ts: "1700000000.123",
      date_created: 1700000000,
      date_scheduled: undefined,
      file_ids: ["F1"],
    });
  });

  test("returns null for records without an id", () => {
    expect(parseDraftRecord({ blocks: [] })).toBeNull();
    expect(parseDraftRecord(null)).toBeNull();
  });
});

describe("listDrafts", () => {
  test("requests active drafts and parses the result", async () => {
    const { client, calls } = createClient({
      "drafts.list": { ok: true, drafts: [rawDraft, { not: "a draft" }] },
    });

    const result = await listDrafts(client, { limit: 10 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("drafts.list");
    expect(calls[0]?.params).toEqual({ is_active: true, limit: 10 });
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]?.id).toBe("Dr123");
  });

  test("omits is_active when activeOnly is false", async () => {
    const { client, calls } = createClient({ "drafts.list": { ok: true, drafts: [] } });

    await listDrafts(client, { activeOnly: false });

    expect(calls[0]?.params.is_active).toBeUndefined();
  });
});

describe("createDraft", () => {
  test("sends blocks, destination, and composer flag", async () => {
    const { client, calls } = createClient({
      "drafts.create": { ok: true, draft: rawDraft },
    });

    const draft = await createDraft(client, {
      channelId: "C123",
      text: "hello",
      threadTs: "1699.000100",
      broadcast: true,
    });

    expect(calls).toHaveLength(1);
    const { params } = calls[0]!;
    expect(calls[0]?.method).toBe("drafts.create");
    expect(params.destinations).toEqual([
      { channel_id: "C123", thread_ts: "1699.000100", broadcast: true },
    ]);
    expect(params.blocks).toEqual([
      {
        type: "rich_text",
        elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "hello" }] }],
      },
    ]);
    expect(params.file_ids).toEqual([]);
    expect(params.is_from_composer).toBe(true);
    expect(typeof params.client_msg_id).toBe("string");
    expect(draft?.id).toBe("Dr123");
  });

  test("omits thread fields for channel drafts", async () => {
    const { client, calls } = createClient({ "drafts.create": { ok: true } });

    await createDraft(client, { channelId: "C123", text: "hello" });

    expect(calls[0]?.params.destinations).toEqual([{ channel_id: "C123" }]);
  });
});

describe("updateDraft", () => {
  test("sends draft_id and a padded last-updated ts", async () => {
    const { client, calls } = createClient({
      "drafts.update": { ok: true, draft: rawDraft },
    });

    await updateDraft(client, {
      draftId: "Dr123",
      clientLastUpdatedTs: "1700000000.123",
      channelId: "C123",
      text: "updated",
      fileIds: ["F1"],
    });

    expect(calls).toHaveLength(1);
    const { params } = calls[0]!;
    expect(calls[0]?.method).toBe("drafts.update");
    expect(params.draft_id).toBe("Dr123");
    expect(params.client_last_updated_ts).toBe("1700000000.1230000");
    expect(params.file_ids).toEqual(["F1"]);
    expect(params.is_from_composer).toBeUndefined();
  });
});

describe("deleteDraft", () => {
  test("deletes with an explicit last-updated ts", async () => {
    const { client, calls } = createClient({ "drafts.delete": { ok: true } });

    await deleteDraft(client, { draftId: "Dr123", clientLastUpdatedTs: "1700000000.123" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("drafts.delete");
    expect(calls[0]?.params).toEqual({
      draft_id: "Dr123",
      client_last_updated_ts: "1700000000.1230000",
    });
  });

  test("fetches the last-updated ts from drafts.list when omitted", async () => {
    const { client, calls } = createClient({
      "drafts.list": { ok: true, drafts: [rawDraft] },
      "drafts.delete": { ok: true },
    });

    await deleteDraft(client, { draftId: "Dr123" });

    expect(calls.map((c) => c.method)).toEqual(["drafts.list", "drafts.delete"]);
    expect(calls[1]?.params.client_last_updated_ts).toBe("1700000000.1230000");
  });

  test("throws when the draft does not exist", async () => {
    const { client } = createClient({ "drafts.list": { ok: true, drafts: [] } });

    expect(deleteDraft(client, { draftId: "DrMissing" })).rejects.toThrow(
      "Draft not found: DrMissing",
    );
  });
});

describe("findDraft", () => {
  test("lists all drafts (including inactive) and finds by id", async () => {
    const { client, calls } = createClient({
      "drafts.list": { ok: true, drafts: [rawDraft] },
    });

    const draft = await findDraft(client, "Dr123");

    expect(draft.id).toBe("Dr123");
    expect(calls[0]?.params.is_active).toBeUndefined();
  });
});
