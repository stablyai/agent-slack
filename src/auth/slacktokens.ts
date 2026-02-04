import { execFileSync } from "node:child_process";
import { ensureSlacktokensPythonEnv } from "./python.ts";

export type SlackTokensExtracted = {
  cookie: { name: string; value: string };
  tokens: Record<string, { token: string; name?: string }>;
};

export function extractViaSlackTokens(pyPath: string): SlackTokensExtracted {
  const python = ensureSlacktokensPythonEnv();
  const code = `
import json, importlib.util, sys
path = ${JSON.stringify(pyPath)}
spec = importlib.util.spec_from_file_location("slacktokens_mod", path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
print(json.dumps(mod.get_tokens_and_cookie()))
  `.trim();

  try {
    const raw = execFileSync(python, ["-c", code], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }) as string;
    return JSON.parse(raw) as SlackTokensExtracted;
  } catch (err: any) {
    const stderr = Buffer.isBuffer(err?.stderr)
      ? err.stderr.toString("utf8")
      : typeof err?.stderr === "string"
        ? err.stderr
        : "";
    const stdout = Buffer.isBuffer(err?.stdout)
      ? err.stdout.toString("utf8")
      : typeof err?.stdout === "string"
        ? err.stdout
        : "";
    const combined = `${stdout}\n${stderr}`.trim();

    if (
      /database appears to be locked|\/LOCK: Resource temporarily unavailable/i.test(
        combined,
      )
    ) {
      throw new Error(
        "Slack Desktop local storage is locked. Quit the Slack app completely (Cmd+Q), then re-run `agent-slack auth import-desktop`.",
      );
    }

    throw new Error(
      combined
        ? `slacktokens failed: ${combined.split("\n").slice(-8).join("\n")}`
        : "slacktokens failed",
    );
  }
}
