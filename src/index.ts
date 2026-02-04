import { Command } from "commander";
import { getPackageVersion } from "./lib/version.ts";
import { createCliContext } from "./cli/context.ts";
import { registerAuthCommand } from "./cli/auth-command.ts";
import { registerCanvasCommand } from "./cli/canvas-command.ts";
import { registerMessageCommand } from "./cli/message-command.ts";
import { registerSearchCommand } from "./cli/search-command.ts";
import { registerUserCommand } from "./cli/user-command.ts";

const program = new Command();
program
  .name("agent-slack")
  .description("Slack automation CLI for AI agents")
  .version(getPackageVersion());

const ctx = createCliContext();

registerAuthCommand({ program, ctx });
registerMessageCommand({ program, ctx });
registerCanvasCommand({ program, ctx });
registerSearchCommand({ program, ctx });
registerUserCommand({ program, ctx });

program.parse(process.argv);
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
