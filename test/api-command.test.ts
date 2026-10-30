import { describe, expect, test } from "bun:test";
import { apiErrorPayload, isReadOnlyApiMethod, parseApiParams } from "../src/cli/api-command.ts";

describe("parseApiParams", () => {
  test("merges --params JSON with -f fields, fields winning", () => {
    expect(
      parseApiParams({
        params: '{"channel":"C1","limit":5}',
        field: ["channel=C2", "ts=1770165109.628379"],
      }),
    ).toEqual({ channel: "C2", limit: 5, ts: "1770165109.628379" });
  });

  test("keeps '=' inside field values", () => {
    expect(parseApiParams({ field: ["query=a=b"] })).toEqual({ query: "a=b" });
  });

  test.each(["[1]", "null", "not json"])("rejects non-object --params %p", (params) => {
    expect(() => parseApiParams({ params })).toThrow("--params must be a JSON object");
  });

  test("rejects a field without a key", () => {
    expect(() => parseApiParams({ field: ["=x"] })).toThrow("-f expects key=value");
  });
});

describe("isReadOnlyApiMethod", () => {
  test.each([
    "client.counts",
    "conversations.history",
    "conversations.replies",
    "users.info",
    "subscriptions.thread.getView",
    "chat.getPermalink",
    "search.messages",
    "auth.test",
  ])("allows read method %p", (method) => {
    expect(isReadOnlyApiMethod(method)).toBe(true);
  });

  test.each(["chat.postMessage", "chat.delete", "saved.update", "reactions.add", "chat.getaway"])(
    "blocks write method %p",
    (method) => {
      expect(isReadOnlyApiMethod(method)).toBe(false);
    },
  );
});

describe("apiErrorPayload", () => {
  test("keeps the Slack body the SDK attached", () => {
    const err = Object.assign(new Error("missing_scope"), {
      data: { ok: false, error: "missing_scope", needed: "chat:write" },
    });
    expect(apiErrorPayload(err)).toEqual({
      ok: false,
      error: "missing_scope",
      needed: "chat:write",
    });
  });

  test("falls back to the error code", () => {
    expect(apiErrorPayload(new Error("channel_not_found"))).toEqual({
      ok: false,
      error: "channel_not_found",
    });
  });
});
