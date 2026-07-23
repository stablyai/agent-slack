import { describe, expect, test } from "bun:test";
import { errorMessage } from "../src/cli/context.ts";

describe("errorMessage", () => {
  test("returns the message for a plain error", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  test("stringifies non-Error values", () => {
    expect(errorMessage("boom")).toBe("boom");
  });

  test("appends a single Error cause", () => {
    const err = new Error("fetch failed", { cause: new Error("connect ECONNREFUSED") });
    expect(errorMessage(err)).toBe("fetch failed: connect ECONNREFUSED");
  });

  test("appends AggregateError causes from a failed fetch through a dead proxy", () => {
    const cause = new AggregateError(
      [
        new Error("connect ECONNREFUSED 127.0.0.1:9090"),
        new Error("connect ECONNREFUSED ::1:9090"),
      ],
      "ECONNREFUSED",
    );
    const err = new Error("fetch failed", { cause });
    expect(errorMessage(err)).toBe(
      "fetch failed: connect ECONNREFUSED 127.0.0.1:9090; connect ECONNREFUSED ::1:9090",
    );
  });

  test("walks multi-level cause chains", () => {
    const root = new Error("connect ECONNREFUSED");
    const middle = new Error("request failed", { cause: root });
    const err = new Error("fetch failed", { cause: middle });
    expect(errorMessage(err)).toBe("fetch failed: request failed: connect ECONNREFUSED");
  });
});
