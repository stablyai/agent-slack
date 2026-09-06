import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_USER_AGENT, getUserAgent } from "../src/lib/version.ts";

describe("getUserAgent", () => {
  const originalUserAgent = process.env.AGENT_SLACK_USER_AGENT;

  afterEach(() => {
    if (originalUserAgent === undefined) {
      delete process.env.AGENT_SLACK_USER_AGENT;
    } else {
      process.env.AGENT_SLACK_USER_AGENT = originalUserAgent;
    }
  });

  test("defaults to a browser-shaped UA, not agent-slack/<version>", () => {
    delete process.env.AGENT_SLACK_USER_AGENT;
    expect(getUserAgent()).toBe(DEFAULT_USER_AGENT);
    expect(getUserAgent()).not.toContain("agent-slack/");
  });

  test("falls back to the default for an unset, empty, or whitespace-only env var", () => {
    for (const value of [undefined, "", "   "]) {
      if (value === undefined) {
        delete process.env.AGENT_SLACK_USER_AGENT;
      } else {
        process.env.AGENT_SLACK_USER_AGENT = value;
      }
      expect(getUserAgent()).toBe(DEFAULT_USER_AGENT);
    }
  });

  test("honors AGENT_SLACK_USER_AGENT when set", () => {
    process.env.AGENT_SLACK_USER_AGENT = "CustomAgent/1.0";
    expect(getUserAgent()).toBe("CustomAgent/1.0");
  });

  test("trims surrounding whitespace from the env var", () => {
    process.env.AGENT_SLACK_USER_AGENT = "  CustomAgent/1.0  ";
    expect(getUserAgent()).toBe("CustomAgent/1.0");
  });
});
