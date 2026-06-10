import { afterEach, describe, expect, test } from "bun:test";
import type { CliContext } from "../src/cli/context.ts";
import {
  isSafeModeEnabled,
  redirectSendToDraft,
  safeModeBlockedError,
} from "../src/cli/safe-mode.ts";

const stubCtx = {} as CliContext;

describe("isSafeModeEnabled", () => {
  test("enabled via CLI flag", () => {
    expect(isSafeModeEnabled({ cliFlag: true, env: {} })).toBe(true);
  });

  test.each(["1", "true", "TRUE", "yes", "on", " 1 "])("enabled for env value %p", (value) => {
    expect(isSafeModeEnabled({ env: { AGENT_SLACK_SAFE_MODE: value } })).toBe(true);
  });

  test.each(["0", "false", "off", "no", ""])("disabled for env value %p", (value) => {
    expect(isSafeModeEnabled({ env: { AGENT_SLACK_SAFE_MODE: value } })).toBe(false);
  });

  test("disabled when env var is unset and flag is absent", () => {
    expect(isSafeModeEnabled({ env: {} })).toBe(false);
    expect(isSafeModeEnabled({ cliFlag: false, env: {} })).toBe(false);
  });
});

describe("safeModeBlockedError", () => {
  test("names the blocked action", () => {
    expect(safeModeBlockedError("edit").message).toContain('"message edit" is blocked');
    expect(safeModeBlockedError("delete").message).toContain('"message delete" is blocked');
  });
});

describe("redirectSendToDraft", () => {
  const originalCi = process.env.CI;

  afterEach(() => {
    if (originalCi === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = originalCi;
    }
  });

  test.each([
    [{ attach: ["./report.md"] }, "--attach"],
    [{ blocks: "/tmp/blocks.json" }, "--blocks"],
    [{ schedule: "2030-01-01T00:00:00Z" }, "--schedule"],
    [{ scheduleIn: "3h" }, "--schedule-in"],
    [{ replyBroadcast: true }, "--reply-broadcast"],
  ])("rejects unsupported send option %p", async (options, flag) => {
    await expect(
      redirectSendToDraft({ ctx: stubCtx, targetInput: "#general", text: "hi", options }),
    ).rejects.toThrow(flag);
  });

  test("lists all unsupported flags at once", async () => {
    const promise = redirectSendToDraft({
      ctx: stubCtx,
      targetInput: "#general",
      text: "hi",
      options: { attach: ["./a.md"], scheduleIn: "3h" },
    });
    await expect(promise).rejects.toThrow("--attach, --schedule-in");
  });

  test("rejects in CI where no interactive editor is available", async () => {
    process.env.CI = "1";
    await expect(
      redirectSendToDraft({ ctx: stubCtx, targetInput: "#general", text: "hi", options: {} }),
    ).rejects.toThrow("unavailable in CI");
  });

  test("opens a draft with the send text and thread context", async () => {
    delete process.env.CI;
    const draftCalls: unknown[] = [];
    const payload = await redirectSendToDraft(
      {
        ctx: stubCtx,
        targetInput: "#general",
        text: "here's the report",
        options: { workspace: "myteam", threadTs: "1770165109.628379" },
      },
      async (input) => {
        draftCalls.push(input);
        return { ok: true, sent: true };
      },
    );
    expect(draftCalls).toEqual([
      {
        ctx: stubCtx,
        targetInput: "#general",
        initialText: "here's the report",
        options: { workspace: "myteam", threadTs: "1770165109.628379" },
      },
    ]);
    expect(payload).toEqual({
      safe_mode: true,
      redirected_from: "send",
      ok: true,
      sent: true,
    });
  });
});
