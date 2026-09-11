import { describe, expect, test } from "bun:test";
import { scheduleNativeMessage } from "../src/slack/native-scheduled-messages.ts";
import type { SlackApiClient } from "../src/slack/client.ts";

const postAt = 1770168709;

function clientReturning(draft: Record<string, unknown>): SlackApiClient {
  return {
    api: async () => ({ ok: true, draft }),
  } as unknown as SlackApiClient;
}

describe("scheduleNativeMessage", () => {
  test("returns only metadata confirmed by the matching scheduled draft", async () => {
    const result = await scheduleNativeMessage(
      clientReturning({
        id: "Dr1234ABCD",
        destinations: [
          { channel_id: "C12345678", thread_ts: "1770160000.000001", broadcast: true },
        ],
        blocks: [
          {
            type: "rich_text",
            elements: [
              { type: "rich_text_section", elements: [{ type: "text", text: "scheduled" }] },
            ],
          },
        ],
        date_scheduled: postAt,
      }),
      {
        channelId: "C12345678",
        text: "scheduled",
        postAt,
        threadTs: "1770160000.000001",
        replyBroadcast: true,
      },
    );

    expect(result).toEqual({
      channel: "C12345678",
      scheduled_message_id: "Dr1234ABCD",
      post_at: postAt,
    });
  });

  test.each([
    {
      caseName: "missing schedule time",
      dateScheduled: undefined,
      destinations: [{ channel_id: "C12345678" }],
    },
    {
      caseName: "different schedule time",
      dateScheduled: postAt + 1,
      destinations: [{ channel_id: "C12345678" }],
    },
    {
      caseName: "different destination",
      dateScheduled: postAt,
      destinations: [{ channel_id: "C99999999" }],
    },
    {
      caseName: "an additional destination",
      dateScheduled: postAt,
      destinations: [{ channel_id: "C12345678" }, { channel_id: "C99999999" }],
    },
  ])("rejects a drafts.create response with $caseName", async ({ dateScheduled, destinations }) => {
    await expect(
      scheduleNativeMessage(
        clientReturning({
          id: "Dr1234ABCD",
          destinations,
          blocks: [
            {
              type: "rich_text",
              elements: [
                { type: "rich_text_section", elements: [{ type: "text", text: "scheduled" }] },
              ],
            },
          ],
          date_scheduled: dateScheduled,
        }),
        { channelId: "C12345678", text: "scheduled", postAt },
      ),
    ).rejects.toThrow("did not confirm a matching native scheduled draft");
  });
});
