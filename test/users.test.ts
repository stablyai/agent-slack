import { describe, expect, test } from "bun:test";
import { resolveUserId } from "../src/slack/users.ts";

describe("resolveUserId", () => {
  test("returns user ids unchanged", async () => {
    const client = {
      api: async () => {
        throw new Error("should not call api for user id");
      },
    };
    expect(await resolveUserId(client as never, "U01ABCDEFG")).toBe("U01ABCDEFG");
  });

  test("resolves @handle via users.list", async () => {
    const client = {
      api: async (method: string) => {
        expect(method).toBe("users.list");
        return {
          ok: true,
          members: [{ id: "U02HANDLE", name: "alice" }],
        };
      },
    };
    expect(await resolveUserId(client as never, "@alice")).toBe("U02HANDLE");
  });

  test("resolves email via users.lookupByEmail", async () => {
    const client = {
      api: async (method: string, params?: Record<string, unknown>) => {
        expect(method).toBe("users.lookupByEmail");
        expect(params?.email).toBe("alice@example.com");
        return {
          ok: true,
          user: { id: "U03EMAIL" },
        };
      },
    };
    expect(await resolveUserId(client as never, "alice@example.com")).toBe("U03EMAIL");
  });

  test("falls back to users.list when lookupByEmail is unavailable", async () => {
    const client = {
      api: async (method: string) => {
        if (method === "users.lookupByEmail") {
          throw new Error("missing_scope");
        }
        return {
          ok: true,
          members: [{ id: "U04FALLBACK", name: "alice", profile: { email: "alice@example.com" } }],
        };
      },
    };
    expect(await resolveUserId(client as never, "alice@example.com")).toBe("U04FALLBACK");
  });
});
