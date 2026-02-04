import { describe, expect, test } from "bun:test";
import { renderSlackMessageContent } from "../src/slack/render.ts";

describe("renderSlackMessageContent", () => {
  test("prefers blocks", () => {
    const msg = {
      text: "Title only",
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "*Hi*\n<https://example.com|View>" },
        },
      ],
    };
    const rendered = renderSlackMessageContent(msg);
    expect(rendered).toBe("*Hi*\n[View](https://example.com)");
  });

  test("falls back to attachments when text is empty", () => {
    const msg = {
      text: "",
      attachments: [
        {
          pretext: "New release published",
          title: "<https://example.com|Release>",
          text: "Hello",
        },
      ],
    };
    const rendered = renderSlackMessageContent(msg);
    expect(rendered).toContain("[Release](https://example.com)");
  });

  test("includes section fields and button URLs", () => {
    const msg = {
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "*Started*" },
          accessory: {
            type: "button",
            text: { type: "plain_text", text: "View" },
            url: "https://example.com/run/1",
          },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: "*Total Tests:*\n1" },
            { type: "mrkdwn", text: "*Triggered By:*\nSCHEDULED" },
          ],
        },
      ],
    };
    const rendered = renderSlackMessageContent(msg);
    expect(rendered).toContain("*Total Tests:*\n1");
    expect(rendered).toContain("*Triggered By:*\nSCHEDULED");
    expect(rendered).toContain("View: https://example.com/run/1");
  });

  test("includes attachment fields", () => {
    const msg = {
      text: "",
      attachments: [
        {
          fields: [
            { title: "Total Tests:", value: "1" },
            { title: "Triggered By:", value: "SCHEDULED" },
          ],
        },
      ],
    };
    const rendered = renderSlackMessageContent(msg);
    expect(rendered).toContain("Total Tests:");
    expect(rendered).toContain("Triggered By:");
  });
});
