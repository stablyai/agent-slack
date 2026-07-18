import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerCanvasCommand } from "../src/cli/canvas-command.ts";
import { registerChannelCommand } from "../src/cli/channel-command.ts";
import type { CliContext } from "../src/cli/context.ts";
import { registerLaterCommand } from "../src/cli/later-command.ts";
import { registerMessageCommand } from "../src/cli/message-command.ts";
import { registerUserCommand } from "../src/cli/user-command.ts";

function findCommand(root: Command, ...path: string[]): Command {
  let current = root;
  for (const name of path) {
    const next = current.commands.find((command) => command.name() === name);
    if (!next) {
      throw new Error(`Missing command: ${path.join(" ")}`);
    }
    current = next;
  }
  return current;
}

function optionDescription(command: Command, long: string): string {
  const option = command.options.find((candidate) => candidate.long === long);
  if (!option) {
    throw new Error(`Missing option ${long} on ${command.name()}`);
  }
  return option.description;
}

function buildProgram(): Command {
  const program = new Command();
  const ctx = {} as CliContext;
  registerMessageCommand({ program, ctx });
  registerCanvasCommand({ program, ctx });
  registerChannelCommand({ program, ctx });
  registerLaterCommand({ program, ctx });
  registerUserCommand({ program, ctx });
  return program;
}

describe("agent-facing help contracts", () => {
  test("message send documents non-obvious formatting and scheduling behavior", () => {
    const send = findCommand(buildProgram(), "message", "send");

    expect(optionDescription(send, "--attach")).toContain("without automatic list conversion");
    expect(optionDescription(send, "--schedule")).toContain("within 120 days");
    expect(optionDescription(send, "--schedule-in")).toContain("local timezone");
    expect(optionDescription(send, "--thread-ts")).toContain("channel targets");
    expect(optionDescription(send, "--reply-broadcast")).toContain("DM targets");
  });

  test("message draft identifies its CI send behavior", () => {
    const draft = findCommand(buildProgram(), "message", "draft");

    expect(draft.description()).toContain("CI skips the editor");
    expect(draft.registeredArguments[1]?.description).toContain("sent immediately");
    expect(optionDescription(draft, "--thread-ts")).toContain("overrides the URL-derived thread");
  });

  test("scheduled cancellation identifies its required channel", () => {
    const cancel = findCommand(buildProgram(), "message", "scheduled", "cancel");

    expect(optionDescription(cancel, "--channel")).toContain("Required");
  });

  test("Later reminders identify named-day timezone behavior", () => {
    const remind = findCommand(buildProgram(), "later", "remind");

    expect(optionDescription(remind, "--in")).toContain("local timezone at 9:00");
    expect(optionDescription(remind, "--in")).toContain("Unix timestamp");
  });

  test("canvas creation identifies source and credential constraints", () => {
    const create = findCommand(buildProgram(), "canvas", "create");

    expect(create.description()).toContain("exactly one Markdown source");
    expect(optionDescription(create, "--file")).toContain("mutually exclusive");
    expect(optionDescription(create, "--channel")).toContain("canvases:write");
    expect(optionDescription(create, "--channel")).toContain("browser auth");
  });

  test("channel mark distinguishes URL and non-URL workspace handling", () => {
    const mark = findCommand(buildProgram(), "channel", "mark");

    expect(optionDescription(mark, "--workspace")).toContain("cannot be used with URL targets");
    expect(optionDescription(mark, "--ts")).toContain("overrides a URL timestamp");
  });

  test("DM help states Slack's group size limit", () => {
    const dmOpen = findCommand(buildProgram(), "user", "dm-open");

    expect(dmOpen.registeredArguments[0]?.description).toContain("One to 8 other user");
    expect(dmOpen.registeredArguments[0]?.description).toContain("caller is implicit");
  });
});
