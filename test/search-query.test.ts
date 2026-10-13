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

  test("resolves an email user filter via users.lookupByEmail", async () => {
    const client = {
      api: async (method: string, params?: Record<string, unknown>) => {
        expect(method).toBe("users.lookupByEmail");
        expect(params).toEqual({ email: "alice@example.com" });
        return { ok: true, user: { id: "U10EMAIL" } };
      },
    };

    expect(await resolveUserId(client as never, "alice@example.com")).toBe("U10EMAIL");
  });

  test("returns undefined for an email that no lookup path can resolve", async () => {
    const client = {
      api: async (method: string) => {
        if (method === "users.lookupByEmail") {
          throw new Error("not_allowed_token_type");
        }
        if (method === "search.modules") {
          return { ok: true, items: [] };
        }
        expect(method).toBe("users.list");
        return { ok: true, members: [] };
      },
    };

    expect(await resolveUserId(client as never, "ghost@example.com")).toBeUndefined();
  });

  test("resolves an email filter via search.modules when lookupByEmail is rejected", async () => {
    const client = {
      api: async (method: string) => {
        if (method === "users.lookupByEmail") {
          throw new Error("not_allowed_token_type");
        }
        expect(method).toBe("search.modules");
        return { ok: true, items: [{ id: "U17SEARCH", profile: { email: "alice@example.com" } }] };
      },
    };

    expect(await resolveUserId(client as never, "alice@example.com")).toBe("U17SEARCH");
  });
});
