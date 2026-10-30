import type { Command } from "commander";
import type { CliContext } from "./context.ts";
import { isSafeModeEnabled } from "./safe-mode.ts";

/**
 * Raw Slack Web API passthrough, like `gh api`: for methods agent-slack has no
 * command for yet. Uses the same workspace auth and auto-refresh as every other
 * command and prints Slack's JSON response unchanged.
 */
export function parseApiParams(input: {
  params?: string;
  field?: string[];
}): Record<string, unknown> {
  let out: Record<string, unknown> = {};
  if (input.params !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.params);
    } catch {
      throw new Error("--params must be a JSON object");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("--params must be a JSON object");
    }
    out = { ...(parsed as Record<string, unknown>) };
  }
  for (const pair of input.field ?? []) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new Error(`-f expects key=value, got "${pair}"`);
    }
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

const READ_ONLY_METHOD =
  /^(auth\.test|search\.[A-Za-z.]+|[A-Za-z.]+\.(list|info|history|replies|counts|getView|get[A-Z][A-Za-z]*))$/;

/** Safe mode keeps writes behind human review, so only read methods pass through. */
export function isReadOnlyApiMethod(method: string): boolean {
  return READ_ONLY_METHOD.test(method);
}

/** Slack's error body when the SDK kept it, else the error code alone; JSON either way. */
export function apiErrorPayload(err: unknown): Record<string, unknown> {
  const data = (err as { data?: unknown } | null)?.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function registerApiCommand(input: { program: Command; ctx: CliContext }): void {
  input.program
    .command("api")
    .description(
      "Call any Slack Web API method with the configured auth and print the raw JSON response",
    )
    .argument("<method>", "Slack Web API method, e.g. client.counts or conversations.replies")
    .option("--workspace <url>", "Workspace selector (full URL or unique substring)")
    .option("--params <json>", "Method arguments as a JSON object")
    .option("-f, --field <key=value>", "Add one string argument (repeatable)", collect, [])
    .option(
      "--multipart",
      "Send as multipart/form-data (some internal methods, e.g. saved.update, ignore form-urlencoded arguments)",
    )
    .action(
      async (
        method: string,
        options: { workspace?: string; params?: string; field?: string[]; multipart?: boolean },
      ) => {
        let params: Record<string, unknown>;
        try {
          params = parseApiParams(options);
          if (
            isSafeModeEnabled({ cliFlag: Boolean(input.program.opts().safeMode) }) &&
            !isReadOnlyApiMethod(method)
          ) {
            throw new Error(
              `Safe mode is active: "api ${method}" is blocked because only read methods (list, info, history, replies, get*, search.*) can run without human review.`,
            );
          }
        } catch (err: unknown) {
          console.error(input.ctx.errorMessage(err));
          process.exitCode = 1;
          return;
        }
        try {
          const workspaceUrl = input.ctx.effectiveWorkspaceUrl(options.workspace);
          const resp = await input.ctx.withAutoRefresh({
            workspaceUrl,
            work: async () => {
              const { client } = await input.ctx.getClientForWorkspace(workspaceUrl);
              return options.multipart
                ? await client.apiMultipart(method, params)
                : await client.api(method, params);
            },
          });
          console.log(JSON.stringify(resp, null, 2));
        } catch (err: unknown) {
          console.log(JSON.stringify(apiErrorPayload(err), null, 2));
          console.error(input.ctx.errorMessage(err));
          process.exitCode = 1;
        }
      },
    );
}
