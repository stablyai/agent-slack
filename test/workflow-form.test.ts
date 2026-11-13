import { describe, expect, test } from "bun:test";
import {
  buildViewState,
  flattenText,
  parseInputPair,
  resolveWorkflowInputs,
  type WorkflowFormField,
} from "../src/slack/workflow-form.ts";

const fields: WorkflowFormField[] = [
  { name: "uuid-note", title: "Note", type: "string", required: true },
  {
    name: "uuid-prio",
    title: "Priority",
    type: "slack#/types/limited_rich_text",
    required: true,
    options: ["Low", "High"],
  },
  { name: "uuid-extra", title: "Extra", type: "string", required: false },
];

describe("parseInputPair", () => {
  test("splits on the first equals sign", () => {
    expect(parseInputPair("Note=a=b")).toEqual({ key: "Note", value: "a=b" });
  });

  test("rejects a pair without a key", () => {
    expect(() => parseInputPair("=x")).toThrow("expected");
    expect(() => parseInputPair("novalue")).toThrow("expected");
  });
});

describe("resolveWorkflowInputs", () => {
  test("matches by title case-insensitively and by field name", () => {
    const out = resolveWorkflowInputs(fields, {
      pairs: ["note=hello", "uuid-prio=high"],
    });
    expect(out).toEqual([
      { name: "uuid-note", title: "Note", type: "string", value: "hello" },
      {
        name: "uuid-prio",
        title: "Priority",
        type: "slack#/types/limited_rich_text",
        value: "High",
      },
    ]);
  });

  test("--input overrides --inputs-json and numbers are stringified", () => {
    const out = resolveWorkflowInputs(fields, {
      json: { Note: "from json", Priority: "Low", Extra: 3 },
      pairs: ["Note=from flag"],
    });
    expect(out.map((i) => i.value)).toEqual(["from flag", "Low", "3"]);
  });

  test("rejects unknown fields and lists the available ones", () => {
    expect(() => resolveWorkflowInputs(fields, { pairs: ["Nope=1"] })).toThrow(
      'Unknown form field "Nope". Available fields: "Note", "Priority", "Extra".',
    );
  });

  test("rejects an invalid dropdown label with the valid options", () => {
    expect(() => resolveWorkflowInputs(fields, { pairs: ["Note=x", "Priority=Urgent"] })).toThrow(
      'Invalid value "Urgent" for "Priority". Options: "Low", "High".',
    );
  });

  test("requires every required field", () => {
    expect(() => resolveWorkflowInputs(fields, { pairs: ["Note=x"] })).toThrow(
      'Missing required input: "Priority".',
    );
  });

  test("rejects an ambiguous title", () => {
    const dup: WorkflowFormField[] = [
      { name: "a", title: "Same", type: "string", required: false },
      { name: "b", title: "same", type: "string", required: false },
    ];
    expect(() => resolveWorkflowInputs(dup, { pairs: ["Same=1"] })).toThrow("ambiguous");
  });

  test("rejects non-object and non-scalar JSON inputs", () => {
    expect(() => resolveWorkflowInputs(fields, { json: ["x"] })).toThrow("JSON object");
    expect(() => resolveWorkflowInputs(fields, { json: { Note: { a: 1 } } })).toThrow(
      "must be a string, number or boolean",
    );
  });
});

const richOption = (text: string) => ({
  text: {
    type: "rich_text",
    elements: [{ type: "rich_text_section", elements: [{ type: "text", text }] }],
  },
  value: text,
});

const view = {
  blocks: [
    {
      type: "input",
      block_id: "B1",
      element: { type: "plain_text_input", action_id: "uuid-note", multiline: true },
    },
    {
      type: "input",
      block_id: "B2",
      element: {
        type: "static_select",
        action_id: "uuid-prio",
        options: [richOption("Low"), richOption("High")],
      },
    },
  ],
};

describe("flattenText", () => {
  test("flattens rich text and plain text objects", () => {
    expect(flattenText(richOption("High").text)).toBe("High");
    expect(flattenText({ type: "plain_text", text: "Hi" })).toBe("Hi");
  });
});

describe("buildViewState", () => {
  test("places each value under the server-generated block id and action id", () => {
    const state = buildViewState(view, [
      { name: "uuid-note", title: "Note", type: "string", value: "hello" },
      { name: "uuid-prio", title: "Priority", type: "x", value: "High" },
    ]);
    expect(state).toEqual({
      values: {
        B1: { "uuid-note": { type: "plain_text_input", value: "hello" } },
        B2: { "uuid-prio": { type: "static_select", selected_option: richOption("High") } },
      },
    });
  });

  test("fails when the form lacks a field or option", () => {
    expect(() =>
      buildViewState(view, [{ name: "missing", title: "Gone", type: "string", value: "x" }]),
    ).toThrow("no field for Gone");
    expect(() =>
      buildViewState(view, [{ name: "uuid-prio", title: "Priority", type: "x", value: "Mid" }]),
    ).toThrow('Option "Mid" is not offered');
  });

  test("supports user, channel and date pickers and rejects unknown element types", () => {
    const v = {
      blocks: [
        { block_id: "U", element: { type: "users_select", action_id: "u" } },
        { block_id: "C", element: { type: "conversations_select", action_id: "c" } },
        { block_id: "D", element: { type: "datepicker", action_id: "d" } },
        { block_id: "X", element: { type: "radio_buttons", action_id: "x" } },
      ],
    };
    const mk = (name: string, value: string) => ({ name, title: name, type: "t", value });
    expect(buildViewState(v, [mk("u", "U1"), mk("c", "C1"), mk("d", "2026-01-02")]).values).toEqual(
      {
        U: { u: { type: "users_select", selected_user: "U1" } },
        C: { c: { type: "conversations_select", selected_conversation: "C1" } },
        D: { d: { type: "datepicker", selected_date: "2026-01-02" } },
      },
    );
    expect(() => buildViewState(v, [mk("x", "1")])).toThrow(
      'type "radio_buttons" is not supported',
    );
  });
});
