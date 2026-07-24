const GLOBAL_BOOLEAN_OPTIONS = new Set(["--safe-mode"]);

export function shouldStartCommandWatchdog(args: string[]): boolean {
  const [command, subcommand] = args;
  if (!command || command === "update") {
    return false;
  }
  if (command === "message" && subcommand === "draft") {
    return false;
  }
  const [normalizedCommand, normalizedSubcommand] = args.filter(
    (arg) => !GLOBAL_BOOLEAN_OPTIONS.has(arg),
  );
  if (normalizedCommand === "user" && normalizedSubcommand === "resolve") {
    return false;
  }
  return true;
}
