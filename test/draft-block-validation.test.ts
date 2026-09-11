import { describe, expect, test } from "bun:test";
import { createDraft } from "../src/slack/drafts.ts";
import type { SlackApiClient } from "../src/slack/client.ts";

function createClient() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const client = {
    api: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      return { ok: true };
    },
  } as unknown as SlackApiClient;
  return { client, calls };
}

describe("native draft block validation", () => {
  test.each(["rich_text_list", "rich_text_quote", "rich_text_preformatted"])(
    "requires a section newline before %s",
    async (type) => {
      const { client, calls } = createClient();

      await expect(
        createDraft(client, {
          channelId: "C123",
          text: "fallback",
          blocks: [
            {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [{ type: "text", text: "Introduction" }],
                },
                {
                  type,
                  elements:
                    type === "rich_text_list"
                      ? [
                          {
                            type: "rich_text_section",
                            elements: [{ type: "text", text: "Item" }],
                          },
                        ]
                      : [{ type: "text", text: "Item" }],
                },
              ],
            },
          ],
        }),
      ).rejects.toThrow(`immediately before ${type}`);
      expect(calls).toHaveLength(0);
    },
  );

  test("accepts a newline-terminated section before a list", async () => {
    const { client, calls } = createClient();

    await createDraft(client, {
      channelId: "C123",
      text: "fallback",
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "text", text: "Introduction\n" }],
            },
            {
              type: "rich_text_list",
              style: "bullet",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [{ type: "text", text: "Item" }],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(calls).toHaveLength(1);
  });

  test("preserves other section adjacency without requiring a newline", async () => {
    const { client, calls } = createClient();

    await createDraft(client, {
      channelId: "C123",
      text: "fallback",
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "text", text: "First" }],
            },
            {
              type: "rich_text_section",
              elements: [{ type: "text", text: "Second" }],
            },
          ],
        },
      ],
    });

    expect(calls).toHaveLength(1);
  });

  test("accepts valid non-text rich-text content that Markdown rendering omits", async () => {
    const { client, calls } = createClient();

    await createDraft(client, {
      channelId: "C123",
      text: "fallback",
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "date", timestamp: 1770168709, format: "{date_long}" }],
            },
          ],
        },
      ],
    });

    expect(calls).toHaveLength(1);
  });
});
