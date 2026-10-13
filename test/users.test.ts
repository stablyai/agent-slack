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

  test("resolves email via search.modules when lookupByEmail rejects the token", async () => {
    const client = {
      api: async (method: string, params?: Record<string, unknown>) => {
        if (method === "users.lookupByEmail") {
          throw new Error("not_allowed_token_type");
        }
        expect(method).toBe("search.modules");
        expect(params).toEqual({ module: "people", query: "alice@example.com", count: 5 });
        return { ok: true, items: [{ id: "U06SEARCH", profile: { email: "Alice@example.com" } }] };
      },
    };
    expect(await resolveUserId(client as never, "alice@example.com")).toBe("U06SEARCH");
  });

  test("retries search.modules with the stored org workspace on team_is_restricted", async () => {
    const workspaceUrls: string[] = [];
    const client = {
      api: async (method: string) => {
        if (method === "team.info") {
          return { ok: true, team: { id: "T1", enterprise_domain: "acme" } };
        }
        expect(method).not.toBe("users.list");
        throw new Error(
          method === "search.modules" ? "team_is_restricted" : "not_allowed_token_type",
        );
      },
      forWorkspace: async (url: string) => {
        workspaceUrls.push(url);
        return {
          api: async (method: string) => {
            expect(method).toBe("search.modules");
            return { ok: true, items: [{ id: "U07ORG", profile: { email: "alice@example.com" } }] };
          },
        };
      },
    };
    expect(await resolveUserId(client as never, "alice@example.com")).toBe("U07ORG");
    expect(workspaceUrls).toEqual(["https://acme.enterprise.slack.com"]);
  });

  test("ignores search.modules results whose email does not match exactly", async () => {
    const client = {
      api: async (method: string) => {
        if (method === "users.lookupByEmail") {
          throw new Error("not_allowed_token_type");
        }
        if (method === "search.modules") {
          return {
            ok: true,
            items: [{ id: "U08OTHER", profile: { email: "alice.b@example.com" } }],
          };
        }
        expect(method).toBe("users.list");
        return {
          ok: true,
          members: [{ id: "U09LIST", name: "alice", profile: { email: "alice@example.com" } }],
        };
      },
    };
    expect(await resolveUserId(client as never, "alice@example.com")).toBe("U09LIST");
  });

  const usersListFallback = (calls: string[]) => ({
    ok: true,
    members: [{ id: "U09LIST", name: "alice", profile: { email: "alice@example.com" } }],
    _calls: calls,
  });

  // Each case fails a different step after team_is_restricted; all must end at users.list.
  const restrictedCases: {
    name: string;
    teamInfo: () => Record<string, unknown>;
    forWorkspace: () => Promise<unknown>;
  }[] = [
    {
      name: "team.info itself fails",
      teamInfo: () => {
        throw new Error("ratelimited");
      },
      forWorkspace: async () => {
        throw new Error("forWorkspace should not be called");
      },
    },
    {
      name: "team.info has no enterprise_domain",
      teamInfo: () => ({ ok: true, team: { id: "T1" } }),
      forWorkspace: async () => {
        throw new Error("forWorkspace should not be called");
      },
    },
    {
      name: "the org workspace is not stored",
      teamInfo: () => ({ ok: true, team: { enterprise_domain: "acme" } }),
      forWorkspace: async () => null,
    },
    {
      name: "the org client cannot search either",
      teamInfo: () => ({ ok: true, team: { enterprise_domain: "acme" } }),
      forWorkspace: async () => ({
        api: async () => {
          throw new Error("missing_scope");
        },
      }),
    },
    {
      name: "the org search returns no exact email match",
      teamInfo: () => ({ ok: true, team: { enterprise_domain: "acme" } }),
      forWorkspace: async () => ({
        api: async () => ({
          ok: true,
          items: [{ id: "U11X", profile: { email: "other@example.com" } }],
        }),
      }),
    },
  ];

  for (const c of restrictedCases) {
    test(`falls back to users.list when team_is_restricted and ${c.name}`, async () => {
      const calls: string[] = [];
      const client = {
        api: async (method: string) => {
          calls.push(method);
          if (method === "users.lookupByEmail") {
            throw new Error("not_allowed_token_type");
          }
          if (method === "search.modules") {
            throw new Error("team_is_restricted");
          }
          if (method === "team.info") {
            return c.teamInfo();
          }
          expect(method).toBe("users.list");
          return usersListFallback(calls);
        },
        forWorkspace: c.forWorkspace,
      };
      expect(await resolveUserId(client as never, "alice@example.com")).toBe("U09LIST");
      expect(calls.at(-1)).toBe("users.list");
    });
  }

  test("surfaces unexpected search errors instead of scanning users.list", async () => {
    const calls: string[] = [];
    const client = {
      api: async (method: string) => {
        calls.push(method);
        if (method === "users.lookupByEmail") {
          throw new Error("not_allowed_token_type");
        }
        throw new Error("invalid_auth");
      },
    };
    await expect(resolveUserId(client as never, "alice@example.com")).rejects.toThrow(
      "invalid_auth",
    );
    expect(calls).not.toContain("users.list");
  });

  test("surfaces unexpected errors from the org-context search", async () => {
    const client = {
      api: async (method: string) => {
        if (method === "users.lookupByEmail") {
          throw new Error("not_allowed_token_type");
        }
        if (method === "search.modules") {
          throw new Error("team_is_restricted");
        }
        return { ok: true, team: { enterprise_domain: "acme" } };
      },
      forWorkspace: async () => ({
        api: async () => {
          throw new Error("ratelimited");
        },
      }),
    };
    await expect(resolveUserId(client as never, "alice@example.com")).rejects.toThrow(
      "ratelimited",
    );
  });

  test("passes the same search params to the org-context client", async () => {
    let orgParams: unknown;
    const client = {
      api: async (method: string) => {
        if (method === "users.lookupByEmail") {
          throw new Error("not_allowed_token_type");
        }
        if (method === "search.modules") {
          throw new Error("team_is_restricted");
        }
        return { ok: true, team: { enterprise_domain: "acme" } };
      },
      forWorkspace: async () => ({
        api: async (_method: string, params: unknown) => {
          orgParams = params;
          return { ok: true, items: [{ id: "U12ORG", profile: { email: "alice@example.com" } }] };
        },
      }),
    };
    expect(await resolveUserId(client as never, "alice@example.com")).toBe("U12ORG");
    expect(orgParams).toEqual({ module: "people", query: "alice@example.com", count: 5 });
  });

  test("matches the email case-insensitively when the input is uppercase", async () => {
    const client = {
      api: async (method: string) => {
        if (method === "users.lookupByEmail") {
          throw new Error("not_allowed_token_type");
        }
        return { ok: true, items: [{ id: "U13CASE", profile: { email: "alice@example.com" } }] };
      },
    };
    expect(await resolveUserId(client as never, "ALICE@Example.com")).toBe("U13CASE");
  });

  test("skips search results without an id or with a missing profile", async () => {
    const client = {
      api: async (method: string) => {
        if (method === "users.lookupByEmail") {
          throw new Error("not_allowed_token_type");
        }
        return {
          ok: true,
          items: [
            { profile: { email: "alice@example.com" } },
            { id: "U14NOPROFILE" },
            { id: "U15SECOND", profile: { email: "alice@example.com" } },
          ],
        };
      },
    };
    // An exact-email item without an id must not shadow a later valid match.
    expect(await resolveUserId(client as never, "alice@example.com")).toBe("U15SECOND");
  });

  test.each([
    ["search.modules returns no items", { ok: true }],
    ["search.modules returns an empty list", { ok: true, items: [] }],
    [
      "the only exact match has no id",
      { ok: true, items: [{ profile: { email: "alice@example.com" } }] },
    ],
  ])("falls back to users.list when %s", async (_name, searchResp) => {
    const client = {
      api: async (method: string) => {
        if (method === "users.lookupByEmail") {
          throw new Error("not_allowed_token_type");
        }
        if (method === "search.modules") {
          return searchResp;
        }
        expect(method).toBe("users.list");
        return usersListFallback([]);
      },
    };
    expect(await resolveUserId(client as never, "alice@example.com")).toBe("U09LIST");
  });

  test.each(["not_allowed_token_type", "unknown_method"])(
    "falls back to users.list when search.modules itself is rejected with %s",
    async (code) => {
      const calls: string[] = [];
      const client = {
        api: async (method: string) => {
          calls.push(method);
          if (method === "users.lookupByEmail") {
            throw new Error("not_allowed_token_type");
          }
          if (method === "search.modules") {
            throw new Error(code);
          }
          expect(method).toBe("users.list");
          return usersListFallback(calls);
        },
      };
      expect(await resolveUserId(client as never, "alice@example.com")).toBe("U09LIST");
      expect(calls.at(-1)).toBe("users.list");
    },
  );

  test("tries search.modules when lookupByEmail succeeds without a user id", async () => {
    const client = {
      api: async (method: string) => {
        if (method === "users.lookupByEmail") {
          return { ok: true };
        }
        expect(method).toBe("search.modules");
        return { ok: true, items: [{ id: "U16SEARCH", profile: { email: "alice@example.com" } }] };
      },
    };
    expect(await resolveUserId(client as never, "alice@example.com")).toBe("U16SEARCH");
  });
});
