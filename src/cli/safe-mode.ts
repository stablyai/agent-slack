import type { CliContext } from "./context.ts";
import { draftMessage } from "./draft-actions.ts";

const TRUTHY_VALUES = new Set(["1", "true", "yes", "on"]);

/**
 * Safe mode keeps a human in the loop for anything that posts to Slack:
 * `message send` is redirected to the draft editor, and `message edit` /
 * `message delete` are blocked. Enabled via the global `--safe-mode` flag
 * or the AGENT_SLACK_SAFE_MODE env var ("1", "true", "yes", "on").
 */
export function isSafeModeEnabled(input?: {
  cliFlag?: boolean;
  env?: Record<string, string | undefined>;
}): boolean {
  if (input?.cliFlag) {
    return true;
  }
  const env = input?.env ?? process.env;
  const raw = env.AGENT_SLACK_SAFE_MODE?.trim().toLowerCase();
  return raw !== undefined && TRUTHY_VALUES.has(raw);
}

export function safeModeBlockedError(action: "edit" | "delete"): Error {
  return new Error(
    `Safe mode is active (AGENT_SLACK_SAFE_MODE or --safe-mode): "message ${action}" is blocked so an agent cannot ${action} messages without human review. Disable safe mode to ${action} messages.`,
  );
}

export type SendOptionsForRedirect = {
  workspace?: string;
  threadTs?: string;
  attach?: string[];
  blocks?: string;
  replyBroadcast?: boolean;
  schedule?: string;
  scheduleIn?: string;
};

/**
 * Redirects `message send` to the interactive draft editor so a human
 * reviews and sends the message. Flags the draft editor cannot represent
 * (attachments, raw blocks, scheduling, broadcasts) are rejected instead
 * of being silently dropped.
 */
export async function redirectSendToDraft(
  input: {
    ctx: CliContext;
    targetInput: string;
    text: string;
    options: SendOptionsForRedirect;
  },
  draftFn: typeof draftMessage = draftMessage,
): Promise<Record<string, unknown>> {
  const unsupported: string[] = [];
  if ((input.options.attach ?? []).length > 0) {
    unsupported.push("--attach");
  }
  if (input.options.blocks !== undefined) {
    unsupported.push("--blocks");
  }
  if (input.options.schedule !== undefined) {
    unsupported.push("--schedule");
  }
  if (input.options.scheduleIn !== undefined) {
    unsupported.push("--schedule-in");
  }
  if (input.options.replyBroadcast) {
    unsupported.push("--reply-broadcast");
  }
  if (unsupported.length > 0) {
    throw new Error(
      `Safe mode is active: "message send" is redirected to the draft editor, which does not support ${unsupported.join(", ")}. Drop those flags or disable safe mode.`,
    );
  }
  if (process.env.CI) {
    throw new Error(
      "Safe mode is active but the interactive draft editor is unavailable in CI. Disable safe mode (or unset CI) to send messages.",
    );
  }

  console.error(
    '⚠ Safe mode active: redirecting "message send" → draft editor. Nothing posts until a human sends it from the editor.',
  );

  const payload = await draftFn({
    ctx: input.ctx,
    targetInput: input.targetInput,
    initialText: input.text,
    options: { workspace: input.options.workspace, threadTs: input.options.threadTs },
  });
  return { safe_mode: true, redirected_from: "send", ...payload };
}
