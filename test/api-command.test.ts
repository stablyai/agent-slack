import { describe, expect, test } from "bun:test";
import { parseApiParams } from "../src/cli/api-command.ts";

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
