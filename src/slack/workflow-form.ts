import { asArray, getString, isRecord } from "../lib/object-type-guards.ts";

/** A form field as described by `workflows.get`. */
export type WorkflowFormField = {
  name: string;
  title: string;
  type: string;
  required: boolean;
  /** Allowed option labels for dropdown fields. */
  options?: string[];
};

export type ResolvedWorkflowInput = {
  name: string;
  title: string;
  type: string;
  value: string;
};

export type RawWorkflowInputs = {
  /** `key=value` strings as given to repeated `--input` flags. */
  pairs?: string[];
  /** Parsed `--inputs-json` object. */
  json?: unknown;
};

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

function fieldLabel(field: WorkflowFormField): string {
  return field.title ? `"${field.title}"` : field.name;
}

export function parseInputPair(pair: string): { key: string; value: string } {
  const index = pair.indexOf("=");
  if (index <= 0) {
    throw new Error(`Invalid --input "${pair}": expected "<field title or name>=<value>".`);
  }
  return { key: pair.slice(0, index).trim(), value: pair.slice(index + 1) };
}

function coerceJsonValue(key: string, value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  throw new Error(`--inputs-json value for "${key}" must be a string, number or boolean.`);
}

function collectEntries(raw: RawWorkflowInputs): { key: string; value: string }[] {
  const entries: { key: string; value: string }[] = [];
  if (raw.json !== undefined) {
    if (!isRecord(raw.json) || Array.isArray(raw.json)) {
      throw new Error("--inputs-json must contain a JSON object of field to value.");
    }
    for (const [key, value] of Object.entries(raw.json)) {
      entries.push({ key, value: coerceJsonValue(key, value) });
    }
  }
  for (const pair of raw.pairs ?? []) {
    entries.push(parseInputPair(pair));
  }
  return entries;
}

function findField(fields: WorkflowFormField[], key: string): WorkflowFormField {
  const byName = fields.find((f) => f.name === key);
  if (byName) {
    return byName;
  }
  const byTitle = fields.filter((f) => normalize(f.title) === normalize(key));
  if (byTitle.length === 1) {
    return byTitle[0]!;
  }
  if (byTitle.length > 1) {
    throw new Error(
      `Field title "${key}" is ambiguous (${byTitle.map((f) => f.name).join(", ")}); use the field name instead.`,
    );
  }
  const known = fields.map((f) => (f.title ? `"${f.title}"` : f.name)).join(", ");
  throw new Error(`Unknown form field "${key}". Available fields: ${known}.`);
}

function resolveOption(field: WorkflowFormField, value: string): string {
  const { options } = field;
  if (!options || options.length === 0) {
    return value;
  }
  const match = options.find((o) => normalize(o) === normalize(value));
  if (!match) {
    throw new Error(
      `Invalid value "${value}" for ${fieldLabel(field)}. Options: ${options.map((o) => `"${o}"`).join(", ")}.`,
    );
  }
  return match;
}

/**
 * Match user-supplied inputs to form fields (by uuid name or case-insensitive
 * title), canonicalise dropdown labels and enforce required fields. Later
 * inputs override earlier ones; `--input` pairs override `--inputs-json`.
 */
export function resolveWorkflowInputs(
  fields: WorkflowFormField[],
  raw: RawWorkflowInputs,
): ResolvedWorkflowInput[] {
  const values = new Map<string, string>();
  for (const { key, value } of collectEntries(raw)) {
    const field = findField(fields, key);
    values.set(field.name, resolveOption(field, value));
  }

  const missing = fields.filter((f) => f.required && !values.has(f.name));
  if (missing.length > 0) {
    throw new Error(`Missing required input: ${missing.map(fieldLabel).join(", ")}.`);
  }

  return fields
    .filter((f) => values.has(f.name))
    .map((f) => ({ name: f.name, title: f.title, type: f.type, value: values.get(f.name)! }));
}

/** Flatten a Block Kit text object (plain_text / mrkdwn / rich_text) to plain text. */
export function flattenText(node: unknown): string {
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map(flattenText).join("");
  }
  if (!isRecord(node)) {
    return "";
  }
  if (typeof node.text === "string") {
    return node.text;
  }
  return flattenText(node.elements);
}

type StateValue = Record<string, unknown>;

function matchOption(element: Record<string, unknown>, label: string): Record<string, unknown> {
  const options = asArray(element.options).filter(isRecord);
  const wanted = normalize(label);
  const match = options.find(
    (o) =>
      normalize(flattenText(o.text)) === wanted || normalize(getString(o.value) ?? "") === wanted,
  );
  if (!match) {
    const available = options.map((o) => `"${flattenText(o.text)}"`).join(", ");
    throw new Error(`Option "${label}" is not offered by the form. Options: ${available}.`);
  }
  return match;
}

function stateForElement(element: Record<string, unknown>, value: string): StateValue {
  const type = getString(element.type) ?? "";
  switch (type) {
    case "plain_text_input":
    case "email_text_input":
    case "url_text_input":
    case "number_input":
      return { type, value };
    case "static_select":
      return { type, selected_option: matchOption(element, value) };
    case "users_select":
      return { type, selected_user: value };
    case "conversations_select":
      return { type, selected_conversation: value };
    case "channels_select":
      return { type, selected_channel: value };
    case "datepicker":
      return { type, selected_date: value };
    default:
      throw new Error(`Form field type "${type}" is not supported by workflow run.`);
  }
}

/**
 * Build the `views.submit` state from the form view Slack opened. Block ids are
 * server-generated, so each input is placed by matching its field name to the
 * element's action_id.
 */
export function buildViewState(
  view: Record<string, unknown>,
  inputs: ResolvedWorkflowInput[],
): { values: Record<string, Record<string, StateValue>> } {
  const values: Record<string, Record<string, StateValue>> = {};
  const blocks = asArray(view.blocks).filter(isRecord);
  for (const input of inputs) {
    const block = blocks.find(
      (b) => isRecord(b.element) && getString(b.element.action_id) === input.name,
    );
    if (!block || !isRecord(block.element)) {
      throw new Error(`The opened form has no field for ${input.title || input.name}.`);
    }
    const blockId = getString(block.block_id) ?? "";
    values[blockId] = { [input.name]: stateForElement(block.element, input.value) };
  }
  return { values };
}
