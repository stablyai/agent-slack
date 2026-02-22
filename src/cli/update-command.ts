import type { Command } from "commander";
import {
  checkForUpdate,
  detectInstallMethod,
  getUpdateCommand,
  performPackageManagerUpdate,
  performUpdate,
} from "../lib/update.ts";
import { pruneEmpty } from "../lib/compact-json.ts";

export function registerUpdateCommand(input: { program: Command }): void {
  input.program
    .command("update")
    .description("Update agent-slack to the latest version")
    .option("--check", "Only check for updates (don't install)")
    .action(async (...args) => {
      const [options] = args as [{ check?: boolean }];
      const method = detectInstallMethod();

      try {
        const result = await checkForUpdate(true);

        if (!result) {
          console.error("Could not check for updates. Check your network connection.");
          process.exitCode = 1;
          return;
        }

        if (!result.update_available) {
          console.log(
            JSON.stringify(
              pruneEmpty({ ...result, install_method: method, status: "up_to_date" }),
              null,
              2,
            ),
          );
          return;
        }

        if (options.check) {
          console.log(
            JSON.stringify(
              pruneEmpty({
                ...result,
                install_method: method,
                update_command: getUpdateCommand(method),
                status: "update_available",
              }),
              null,
              2,
            ),
          );
          return;
        }

        process.stderr.write(`Updating agent-slack ${result.current} → ${result.latest}...\n`);

        let outcome: { success: boolean; message: string };
        if (method === "npm" || method === "bun") {
          process.stderr.write(`Detected install method: ${method}\n`);
          outcome = performPackageManagerUpdate(method);
        } else {
          outcome = await performUpdate(result.latest);
        }

        if (!outcome.success) {
          console.error(outcome.message);
          process.exitCode = 1;
          return;
        }

        console.log(
          JSON.stringify(
            pruneEmpty({
              status: "updated",
              install_method: method,
              previous_version: result.current,
              new_version: result.latest,
              message: outcome.message,
            }),
            null,
            2,
          ),
        );
      } catch (err: unknown) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });
}
