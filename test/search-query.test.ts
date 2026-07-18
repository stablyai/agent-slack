import { describe, expect, test } from "bun:test";
import { buildSlackSearchQuery, resolveUserId } from "../src/slack/search-query.ts";

describe("W-prefixed user IDs in search", () => {
  test("resolves a W-prefixed user ID to a from filter", async () => {
    const client = {
      api: async (method: string, params?: Record<string, unknown>) => {
        expect(method).toBe("users.info");
        expect(params).toEqual({ user: "W12345678" });
        return { user: { id: "W12345678", name: "alice" } };
      },
    };

    expect(
      await buildSlackSearchQuery(client as never, {
        query: "deployment",
        user: "W12345678",
      }),
    ).toBe("deployment from:@alice");
  });

  test("returns a W-prefixed user ID without scanning users", async () => {
    const client = {
      api: async () => {
        throw new Error("should not call api for user id");
      },
    };

    expect(await resolveUserId(client as never, "W12345678")).toBe("W12345678");
  });
});
