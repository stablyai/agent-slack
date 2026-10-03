export function shouldStartCommandWatchdog(args: string[]): boolean {
  // Skip global flags (e.g. `--safe-mode`) given before the command; none of
  // them take a value.
  const firstPositional = args.findIndex((arg) => !arg.startsWith("-"));
  const [command, subcommand] = firstPositional === -1 ? [] : args.slice(firstPositional);
  if (!command || command === "update") {
    return false;
  }
  if (command === "message" && subcommand === "draft") {
    return false;
  }
  // These may wait on a macOS keychain prompt that the user has to answer.
  if (command === "auth" && (subcommand === "import-desktop" || subcommand === "import-brave")) {
    return false;
  }
  return true;
}
