import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withEnvironment } from "./helpers/environment.ts";
import {
  indexUsersInCache,
  lookupCachedUserId,
  USER_CACHE_TTL_MS,
} from "../src/slack/user-cache.ts";
import { resolveUserId, warmUserResolutionCache } from "../src/slack/users.ts";

const WORKSPACE_URL = "https://example.slack.com";

async function withUserCacheDir<T>(work: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "agent-slack-user-cache-"));
  return await withEnvironment({ XDG_RUNTIME_DIR: dir }, work);
}

function directoryClient(input: {
  api: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  authType?: "standard" | "browser";
}) {
  return {
    api: input.api,
    getWorkspaceUrl: () => WORKSPACE_URL,
    getAuthType: () => input.authType ?? "standard",
  };
}

describe("resolveUserId", () => {
  test("returns user ids unchanged", async () => {
    const client = {
      api: async () => {
        throw new Error("should not call api for user id");
      },
    };
    expect(await resolveUserId(client as never, "U01ABCDEFG")).toBe("U01ABCDEFG");
  });

  test("returns W-prefixed user ids unchanged", async () => {
    const client = {
      api: async () => {
        throw new Error("should not call api for user id");
      },
    };
    expect(await resolveUserId(client as never, "W01ABCDEFG")).toBe("W01ABCDEFG");
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

  test("resolves @handle case-insensitively", async () => {
    const client = {
      api: async (method: string) => {
        expect(method).toBe("users.list");
        return {
          ok: true,
          members: [{ id: "U05HANDLE", name: "jinjing" }],
        };
      },
    };
    expect(await resolveUserId(client as never, "@Jinjing")).toBe("U05HANDLE");
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

  test("cache hit resolves @handle without users.list", async () => {
    await withUserCacheDir(async () => {
      await indexUsersInCache({
        workspaceUrl: WORKSPACE_URL,
        users: [{ id: "U02HANDLE", name: "alice", email: "alice@example.com" }],
      });
      const client = directoryClient({
        api: async () => {
          throw new Error("should not call api on cache hit");
        },
      });
      expect(await resolveUserId(client as never, "@alice")).toBe("U02HANDLE");
      expect(await resolveUserId(client as never, "alice@example.com")).toBe("U02HANDLE");
    });
  });

  test("cache miss write-through lets a later lookup skip users.list", async () => {
    await withUserCacheDir(async () => {
      let listCalls = 0;
      const client = directoryClient({
        api: async (method: string) => {
          expect(method).toBe("users.list");
          listCalls += 1;
          return {
            ok: true,
            members: [{ id: "U02HANDLE", name: "alice", profile: { email: "alice@example.com" } }],
          };
        },
      });
      expect(await resolveUserId(client as never, "@alice")).toBe("U02HANDLE");
      expect(await resolveUserId(client as never, "@Alice")).toBe("U02HANDLE");
      expect(listCalls).toBe(1);
    });
  });

  test("expired aliases fall through to users.list", async () => {
    await withUserCacheDir(async () => {
      await indexUsersInCache({
        workspaceUrl: WORKSPACE_URL,
        users: [{ id: "U02HANDLE", name: "alice" }],
        fetchedAt: Date.now() - USER_CACHE_TTL_MS - 1,
      });
      let listCalls = 0;
      const client = directoryClient({
        api: async (method: string) => {
          expect(method).toBe("users.list");
          listCalls += 1;
          return { ok: true, members: [{ id: "U09FRESH", name: "alice" }] };
        },
      });
      expect(await resolveUserId(client as never, "@alice")).toBe("U09FRESH");
      expect(listCalls).toBe(1);
    });
  });

  test("skips users.lookupByEmail for browser auth", async () => {
    await withUserCacheDir(async () => {
      const methods: string[] = [];
      const client = directoryClient({
        authType: "browser",
        api: async (method: string) => {
          methods.push(method);
          if (method === "users.lookupByEmail") {
            throw new Error("not_allowed_token_type");
          }
          return {
            ok: true,
            members: [{ id: "U03EMAIL", name: "alice", profile: { email: "alice@example.com" } }],
          };
        },
      });
      expect(await resolveUserId(client as never, "alice@example.com")).toBe("U03EMAIL");
      expect(methods).toEqual(["users.list"]);
    });
  });

  test("forceRefresh bypasses a warm cache", async () => {
    await withUserCacheDir(async () => {
      await indexUsersInCache({
        workspaceUrl: WORKSPACE_URL,
        users: [{ id: "U02HANDLE", name: "alice" }],
      });
      let listCalls = 0;
      const client = directoryClient({
        api: async (method: string) => {
          expect(method).toBe("users.list");
          listCalls += 1;
          return { ok: true, members: [{ id: "U09FRESH", name: "alice" }] };
        },
      });
      expect(await resolveUserId(client as never, "@alice", { forceRefresh: true })).toBe(
        "U09FRESH",
      );
      expect(listCalls).toBe(1);
    });
  });

  test("user cache warm indexes the full directory for later lookups", async () => {
    await withUserCacheDir(async () => {
      const methods: string[] = [];
      const client = directoryClient({
        api: async (method: string, params?: Record<string, unknown>) => {
          methods.push(method);
          expect(method).toBe("users.list");
          if (!params?.cursor) {
            return {
              ok: true,
              members: [{ id: "U01PAGE11", name: "alice" }],
              response_metadata: { next_cursor: "page2" },
            };
          }
          expect(params.cursor).toBe("page2");
          return { ok: true, members: [{ id: "U02PAGE22", name: "bob" }] };
        },
      });
      expect(await warmUserResolutionCache(client as never)).toEqual({
        users_indexed: 2,
        pages: 2,
      });
      const cached = await lookupCachedUserId({
        workspaceUrl: WORKSPACE_URL,
        handle: "bob",
      });
      expect(cached).toBe("U02PAGE22");
      expect(await resolveUserId(client as never, "@bob")).toBe("U02PAGE22");
      expect(methods).toEqual(["users.list", "users.list"]);
    });
  });
});
