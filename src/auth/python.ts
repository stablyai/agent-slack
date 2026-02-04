import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_VENV_DIR = join(homedir(), ".config", "agent-slack", "pyenv");

function safeExec(cmd: string, stdio: "inherit" | "quiet" = "inherit"): void {
  if (stdio === "inherit") {
    execSync(cmd, { stdio: "inherit" });
    return;
  }
  execSync(cmd, { stdio: ["ignore", "ignore", "inherit"] });
}

function pickBasePython(): string {
  const candidates = [
    "/usr/local/bin/python3",
    "/opt/homebrew/bin/python3",
    "python3",
  ];
  for (const c of candidates) {
    try {
      execSync(`${c} -c "import sys; print(sys.version)"`, {
        stdio: ["ignore", "ignore", "ignore"],
      });
      return c;
    } catch {
      // continue
    }
  }
  return "python3";
}

export function ensureSlacktokensPythonEnv(options?: {
  venvDir?: string;
}): string {
  const venvDir = options?.venvDir ?? DEFAULT_VENV_DIR;
  const venvPython = join(venvDir, "bin", "python");

  if (!existsSync(venvPython)) {
    const base = pickBasePython();
    safeExec(`${base} -m venv ${JSON.stringify(venvDir)}`);
  }

  safeExec(
    `${JSON.stringify(venvPython)} -m pip --disable-pip-version-check -q install -U pip`,
    "quiet",
  );
  safeExec(
    `${JSON.stringify(venvPython)} -m pip --disable-pip-version-check -q install leveldb pycookiecheat`,
    "quiet",
  );

  return venvPython;
}
