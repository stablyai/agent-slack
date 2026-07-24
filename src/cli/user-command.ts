import type { Command } from "commander";
import type { CliContext } from "./context.ts";
import { pruneEmpty } from "../lib/compact-json.ts";
import { getDmChannelForUsers, getUser, listUsers } from "../slack/users.ts";
import {
  incompleteStrictUserResolution,
  makeStrictUserOutputInert,
  resolveStrictUserIdentities,
  StrictUserDirectoryRequestError,
} from "../slack/strict-user-resolution.ts";

export function registerUserCommand(input: { program: Command; ctx: CliContext }): void {
  const userCmd = input.program.command("user").description("Workspace user directory");

  userCmd
    .command("list")
    .description("List users in the workspace")
    .option(
      "--workspace <url>",
      "Workspace selector (full URL or unique substring; required if you have multiple workspaces)",
    )
    .option("--limit <n>", "Max users (default 200)", "200")
    .option("--cursor <cursor>", "Pagination cursor")
    .option("--include-bots", "Include bot users")
    .action(async (...args) => {
      const [options] = args as [
        { workspace?: string; limit: string; cursor?: string; includeBots?: boolean },
      ];
      try {
        const workspaceUrl = input.ctx.effectiveWorkspaceUrl(options.workspace);
        const payload = await input.ctx.withAutoRefresh({
          workspaceUrl,
          work: async () => {
            const { client } = await input.ctx.getClientForWorkspace(workspaceUrl);
            const limit = Number.parseInt(options.limit, 10);
            return await listUsers(client, {
              limit,
              cursor: options.cursor,
              includeBots: Boolean(options.includeBots),
            });
          },
        });
        console.log(JSON.stringify(pruneEmpty(payload), null, 2));
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });

  userCmd
    .command("resolve")
    .description(
      "Resolve exact active humans across the complete directory with all-or-none mentions",
    )
    .argument(
      "<identities...>",
      "User IDs (U.../W...), emails, @handles/handles, or full names containing whitespace (quote in the shell)",
    )
    .option(
      "--workspace <url>",
      "Workspace selector (full URL or unique substring; required if you have multiple workspaces)",
    )
    .action(async (...args) => {
      const [identities, options] = args as [string[], { workspace?: string }];
      const workspaceUrl = input.ctx.effectiveWorkspaceUrl(options.workspace);
      let resolvedWorkspaceUrl: string | undefined;
      try {
        const resolution = await input.ctx.withAutoRefresh({
          workspaceUrl,
          work: async () => {
            const { client, workspace_url } = await input.ctx.getClientForWorkspace(workspaceUrl);
            resolvedWorkspaceUrl = normalizeWorkspaceUrl(input.ctx, workspace_url);
            return await resolveStrictUserIdentities({
              client,
              identities,
            });
          },
        });
        const payload = { workspace: resolvedWorkspaceUrl, ...resolution };
        console.log(JSON.stringify(pruneEmpty(payload), null, 2));
        if (!resolution.safe_to_mention) {
          process.exitCode = 1;
        }
      } catch (err: unknown) {
        if (err instanceof StrictUserDirectoryRequestError) {
          const resolution = incompleteStrictUserResolution({
            pages: err.pages,
            reason: err.reason,
          });
          const payload = { workspace: resolvedWorkspaceUrl, ...resolution };
          console.log(JSON.stringify(pruneEmpty(payload), null, 2));
          process.exitCode = 1;
          return;
        }
        console.error(makeStrictUserOutputInert(input.ctx.errorMessage(err)));
        process.exitCode = 1;
      }
    });

  userCmd
    .command("get")
    .description("Get a single workspace user")
    .argument("<user>", "User ID (U.../W...) or @handle/handle")
    .option(
      "--workspace <url>",
      "Workspace selector (full URL or unique substring; required if you have multiple workspaces)",
    )
    .action(async (...args) => {
      const [user, options] = args as [string, { workspace?: string }];
      try {
        const workspaceUrl = input.ctx.effectiveWorkspaceUrl(options.workspace);
        const payload = await input.ctx.withAutoRefresh({
          workspaceUrl,
          work: async () => {
            const { client } = await input.ctx.getClientForWorkspace(workspaceUrl);
            return await getUser(client, user);
          },
        });
        console.log(JSON.stringify(pruneEmpty(payload), null, 2));
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });

  userCmd
    .command("dm-open")
    .description("Open or get a DM / group DM channel")
    .argument("<users...>", "One to 8 other user IDs (U.../W...) or @handles; caller is implicit")
    .option("--workspace <url>", "Workspace URL (required if you have multiple workspaces)")
    .action(async (...args) => {
      const [users, options] = args as [string[], { workspace?: string }];
      try {
        const workspaceUrl = input.ctx.effectiveWorkspaceUrl(options.workspace);
        const payload = await input.ctx.withAutoRefresh({
          workspaceUrl,
          work: async () => {
            const { client } = await input.ctx.getClientForWorkspace(workspaceUrl);
            return await getDmChannelForUsers(client, users);
          },
        });
        console.log(JSON.stringify(pruneEmpty(payload), null, 2));
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });
}

function normalizeWorkspaceUrl(
  ctx: CliContext,
  workspaceUrl: string | undefined,
): string | undefined {
  if (!workspaceUrl) {
    return undefined;
  }
  try {
    return ctx.normalizeUrl(workspaceUrl);
  } catch {
    return undefined;
  }
}
