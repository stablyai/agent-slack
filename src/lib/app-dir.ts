import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export function getAppDir(): string {
  const xdg = process.env.XDG_RUNTIME_DIR?.trim();
  if (xdg) {
    return join(xdg, "agent-slack");
  }

  const home = homedir();
  if (home) {
    return join(home, ".agent-slack");
  }

  return join(tmpdir(), "agent-slack");
}
