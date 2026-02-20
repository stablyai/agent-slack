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

  test("renders forwarded message with author and source link", () => {
    const msg = {
      blocks: [
        {
          type: "rich_text",
          elements: [{ type: "rich_text_section", elements: [{ type: "emoji", name: "eyes" }] }],
        },
      ],
      attachments: [
        {
          is_msg_unfurl: true,
          is_share: true,
          author_name: "Alice",
          author_link: "https://example.slack.com/team/U111",
          from_url: "https://example.slack.com/archives/C222/p333",
          message_blocks: [
            {
              message: {
                blocks: [
                  {
                    type: "rich_text",
                    elements: [
                      {
                        type: "rich_text_section",
                        elements: [{ type: "text", text: "Hello from Alice" }],
                      },
                    ],
                  },
                ],
              },
            },
          ],
          text: "Hello from Alice",
        },
      ],
    };
    const rendered = renderSlackMessageContent(msg);
    expect(rendered).toContain("👀");
    expect(rendered).toContain("[Alice](https://example.slack.com/team/U111)");
    expect(rendered).toContain("[original](https://example.slack.com/archives/C222/p333)");
    expect(rendered).toContain("> Hello from Alice");
  });

  test("renders forwarded message with author name only", () => {
    const msg = {
      text: "",
      attachments: [
        {
          is_share: true,
          author_name: "Bob",
          text: "Some forwarded text",
        },
      ],
    };
    const rendered = renderSlackMessageContent(msg);
    expect(rendered).toContain("Forwarded from Bob");
    expect(rendered).toContain("> Some forwarded text");
  });

  test("renders forwarded message with no author", () => {
    const msg = {
      text: "",
      attachments: [
        {
          is_share: true,
          from_url: "https://example.slack.com/archives/C222/p333",
          text: "Anonymous forward",
        },
      ],
    };
    const rendered = renderSlackMessageContent(msg);
    expect(rendered).toContain("Forwarded message");
    expect(rendered).toContain("[original](https://example.slack.com/archives/C222/p333)");
    expect(rendered).toContain("> Anonymous forward");
  });

  test("includes forwarded file links in quoted forwarded body", () => {
    const msg = {
      text: "",
      attachments: [
        {
          is_share: true,
          from_url: "https://example.slack.com/archives/C222/p333",
          message_blocks: [
            {
              message: {
                text: "Forwarded with image",
              },
            },
          ],
          files: [
            {
              name: "image.png",
              permalink: "https://example.slack.com/files/U1/F1/image.png",
            },
          ],
        },
      ],
    };
    const rendered = renderSlackMessageContent(msg);
    expect(rendered).toContain("> Forwarded with image");
    expect(rendered).toContain("> [image.png](https://example.slack.com/files/U1/F1/image.png)");
  });

  test("renders nested forwarded attachments similarly to normal attachments", () => {
    const msg = {
      text: "",
      attachments: [
        {
          is_share: true,
          author_name: "Carol",
          message_blocks: [
            {
              message: {
                attachments: [
                  {
                    title: "Nested update",
                    title_link: "https://example.com/update",
                    text: "Deployment passed",
                    fields: [{ title: "Env", value: "prod" }],
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const rendered = renderSlackMessageContent(msg);
    expect(rendered).toContain("Forwarded from Carol");
    expect(rendered).toContain("> [Nested update](https://example.com/update)");
    expect(rendered).toContain("> Deployment passed");
    expect(rendered).toContain("> Env");
    expect(rendered).toContain("> prod");
  });

  test("deduplicates repeated forwarded body content", () => {
    const msg = {
      text: "",
      attachments: [
        {
          is_share: true,
          text: "Same content",
          message_blocks: [
            {
              message: {
                text: "Same content",
              },
            },
          ],
        },
      ],
    };
    const rendered = renderSlackMessageContent(msg);
    const matches = rendered.match(/> Same content/g) ?? [];
    expect(matches.length).toBe(1);
  });

  test("handles cyclic forwarded attachments without infinite recursion", () => {
    const shared: Record<string, unknown> = {
      is_share: true,
      author_name: "Loop User",
      text: "Cycle-safe text",
    };
    shared.message_blocks = [{ message: { attachments: [shared] } }];

    const msg = { text: "", attachments: [shared] };
    const rendered = renderSlackMessageContent(msg);
    expect(rendered).toContain("Forwarded from Loop User");
    expect(rendered).toContain("> Cycle-safe text");
  });

  test("does not treat link unfurl as forwarded message", () => {
    const msg = {
      text: "",
      attachments: [
        {
          from_url: "https://github.com/org/repo/pull/42",
          title: "Fix login bug",
          title_link: "https://github.com/org/repo/pull/42",
          text: "This PR fixes the login flow",
        },
      ],
    };
    const rendered = renderSlackMessageContent(msg);
    expect(rendered).not.toContain("Forwarded");
    expect(rendered).toContain("[Fix login bug](https://github.com/org/repo/pull/42)");
    expect(rendered).toContain("This PR fixes the login flow");
  });

  test("combines blocks and non-shared attachments", () => {
    const msg = {
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "Main content" } }],
      attachments: [{ pretext: "Bot notification", text: "Details here" }],
    };
    const rendered = renderSlackMessageContent(msg);
    expect(rendered).toContain("Main content");
    expect(rendered).toContain("Bot notification");
    expect(rendered).toContain("Details here");
  });
});
