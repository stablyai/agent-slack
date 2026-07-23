import { afterEach, describe, expect, test } from "bun:test";
import { getSlackProxyAgent } from "../src/lib/proxy.ts";

const PROXY_ENV_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];

afterEach(() => {
  for (const key of PROXY_ENV_VARS) {
    delete process.env[key];
  }
});

describe("getSlackProxyAgent", () => {
  test("returns undefined when no proxy env vars are set", () => {
    expect(getSlackProxyAgent()).toBeUndefined();
  });

  test("returns an agent when HTTPS_PROXY is set", () => {
    process.env.HTTPS_PROXY = "http://proxy.internal:8080";
    expect(getSlackProxyAgent()).toBeDefined();
  });

  test("falls back to lowercase and HTTP_PROXY variants", () => {
    process.env.http_proxy = "http://proxy.internal:8080";
    expect(getSlackProxyAgent()).toBeDefined();
  });

  test("ignores blank proxy env vars", () => {
    process.env.HTTPS_PROXY = "   ";
    expect(getSlackProxyAgent()).toBeUndefined();
  });
});
