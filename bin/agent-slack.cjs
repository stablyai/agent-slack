#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function die(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function isMuslLinux() {
  if (process.platform !== "linux") {
    return false;
  }
  try {
    const out = childProcess.spawnSync("ldd", ["--version"], { encoding: "utf8" });
    if (out.stdout && /musl/i.test(out.stdout)) {
      return true;
    }
    if (out.stderr && /musl/i.test(out.stderr)) {
      return true;
    }
  } catch {
    // ignore
  }
  try {
    const libEntries = fs.readdirSync("/lib");
    if (libEntries.some((n) => n.startsWith("ld-musl-"))) {
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

function resolveAssetName() {
  const { platform } = process;
  const { arch } = process;

  const plat =
    platform === "darwin"
      ? "darwin"
      : platform === "linux"
        ? "linux"
        : platform === "win32"
          ? "windows"
          : null;
  if (!plat) {
    die(`unsupported platform: ${platform}`);
  }

  const a = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : null;
  if (!a) {
    die(`unsupported architecture: ${arch}`);
  }

  const muslSuffix = plat === "linux" && isMuslLinux() ? "-musl" : "";
  const exeSuffix = plat === "windows" ? ".exe" : "";
  return `agent-slack-${plat}-${a}${muslSuffix}${exeSuffix}`;
}

function main() {
  const asset = resolveAssetName();
  const binPath = path.join(__dirname, "native", asset);

  if (!fs.existsSync(binPath)) {
    die(
      [
        `missing native binary: ${binPath}`,
        "try reinstalling (postinstall downloads it):",
        "  npm i -g agent-slack",
        "or set AGENT_SLACK_SKIP_DOWNLOAD=0 and reinstall if you disabled postinstall.",
      ].join("\n"),
    );
  }

  try {
    fs.chmodSync(binPath, 0o755);
  } catch {
    // ignore
  }

  const result = childProcess.spawnSync(binPath, process.argv.slice(2), { stdio: "inherit" });
  if (typeof result.status === "number") {
    process.exit(result.status);
  }
  if (result.error) {
    die(result.error.message);
  }
  process.exit(1);
}

main();
