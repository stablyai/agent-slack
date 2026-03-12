import { describe, expect, test } from "bun:test";
import { requireBrowserAuth, validateFieldInputs } from "../src/slack/workflow-submit.ts";
import type { WorkflowSchema } from "../src/slack/workflows.ts";
import type { SlackAuth } from "../src/slack/client.ts";

function makeSchema(fields: Partial<WorkflowSchema["fields"][number]>[]): WorkflowSchema {
  return {
    workflow_id: "Wf000TEST",
    title: "Test Workflow",
    description: "A test workflow",
    fields: fields.map((f, i) => ({
      name: `field_${i}`,
      title: f.title ?? `Field ${i}`,
      type: f.type ?? "text",
      description: f.description ?? "",
      required: f.required ?? false,
      ...f,
    })),
    steps: [],
  };
}

describe("validateFieldInputs", () => {
  test("returns no errors for valid required fields", () => {
    const schema = makeSchema([
      { title: "Summary", required: true },
      { title: "Details", required: false },
    ]);
    const fields = new Map([["Summary", "some text"]]);
    expect(validateFieldInputs(fields, schema)).toEqual([]);
  });

  test("returns no errors when all fields provided", () => {
    const schema = makeSchema([
      { title: "Summary", required: true },
      { title: "Details", required: true },
    ]);
    const fields = new Map([
      ["Summary", "text"],
      ["Details", "more text"],
    ]);
    expect(validateFieldInputs(fields, schema)).toEqual([]);
  });

  test("reports unknown field titles", () => {
    const schema = makeSchema([{ title: "Summary" }]);
    const fields = new Map([["Bogus", "value"]]);
    const errors = validateFieldInputs(fields, schema);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Unknown field");
    expect(errors[0]).toContain("Bogus");
    expect(errors[0]).toContain("Summary");
  });

  test("reports missing required fields", () => {
    const schema = makeSchema([
      { title: "First", required: true },
      { title: "Second", required: true },
    ]);
    const fields = new Map<string, string>();
    const errors = validateFieldInputs(fields, schema);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("First");
    expect(errors[1]).toContain("Second");
  });

  test("does not report missing optional fields", () => {
    const schema = makeSchema([
      { title: "Summary", required: true },
      { title: "Extra", required: false },
    ]);
    const fields = new Map([["Summary", "text"]]);
    expect(validateFieldInputs(fields, schema)).toEqual([]);
  });

  test("matches field titles case-insensitively", () => {
    const schema = makeSchema([{ title: "Summary", required: true }]);
    const fields = new Map([["summary", "text"]]);
    expect(validateFieldInputs(fields, schema)).toEqual([]);
  });

  test("matches unknown check case-insensitively", () => {
    const schema = makeSchema([{ title: "Summary" }]);
    const fields = new Map([["SUMMARY", "text"]]);
    expect(validateFieldInputs(fields, schema)).toEqual([]);
  });

  test("reports both unknown and missing errors together", () => {
    const schema = makeSchema([{ title: "Summary", required: true }]);
    const fields = new Map([["Bogus", "value"]]);
    const errors = validateFieldInputs(fields, schema);
    expect(errors).toHaveLength(2);
    expect(errors.some((e) => e.includes("Unknown"))).toBe(true);
    expect(errors.some((e) => e.includes("missing"))).toBe(true);
  });

  test("handles emoji in field titles", () => {
    const schema = makeSchema([{ title: "Label", required: true }]);
    const fields = new Map([["Label", "text"]]);
    expect(validateFieldInputs(fields, schema)).toEqual([]);
  });

  test("returns no errors for empty schema with no fields", () => {
    const schema = makeSchema([]);
    const fields = new Map<string, string>();
    expect(validateFieldInputs(fields, schema)).toEqual([]);
  });
});

describe("requireBrowserAuth", () => {
  test("does not throw for browser auth", () => {
    const auth: SlackAuth = {
      auth_type: "browser",
      xoxc_token: "xoxc-fake",
      xoxd_cookie: "xoxd-fake",
    };
    expect(() => requireBrowserAuth(auth)).not.toThrow();
  });

  test("throws for standard auth", () => {
    const auth: SlackAuth = {
      auth_type: "standard",
      token: "xoxb-fake",
    };
    expect(() => requireBrowserAuth(auth)).toThrow("browser auth");
  });
});
