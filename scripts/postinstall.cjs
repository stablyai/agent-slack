#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");
const { URL } = require("node:url");

function log(message) {
  process.stdout.write(`${message}\n`);
}

function err(message) {
  process.stderr.write(`${message}\n`);
}

function have(command) {
  try {
    const out = childProcess.spawnSync(command, ["--version"], { stdio: "ignore" });
    return out.status === 0;
  } catch {
    return false;
  }
}

function isMuslLinux() {
  if (process.platform !== "linux") return false;
  try {
    const out = childProcess.spawnSync("ldd", ["--version"], { encoding: "utf8" });
    if (out.stdout && /musl/i.test(out.stdout)) return true;
    if (out.stderr && /musl/i.test(out.stderr)) return true;
  } catch {
    // ignore
  }
  try {
    const libEntries = fs.readdirSync("/lib");
    if (libEntries.some((n) => n.startsWith("ld-musl-"))) return true;
  } catch {
    // ignore
  }
  return false;
}

function resolveAssetName() {
  const platform = process.platform;
  const arch = process.arch;

  const plat =
    platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : platform === "win32" ? "windows" : null;
  if (!plat) throw new Error(`unsupported platform: ${platform}`);

  const a = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : null;
  if (!a) throw new Error(`unsupported architecture: ${arch}`);

  const muslSuffix = plat === "linux" && isMuslLinux() ? "-musl" : "";
  const exeSuffix = plat === "windows" ? ".exe" : "";
  return `agent-slack-${plat}-${a}${muslSuffix}${exeSuffix}`;
}

function getPackageVersion() {
  const pkgPath = path.join(__dirname, "..", "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  if (!pkg.version) throw new Error("package.json missing version");
  return String(pkg.version);
}

function getRepo() {
  const envRepo = process.env.AGENT_SLACK_REPO;
  if (envRepo) return envRepo;

  const pkgPath = path.join(__dirname, "..", "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  if (typeof pkg.repository === "string") return pkg.repository;
  if (pkg.repository && typeof pkg.repository.url === "string") {
    const url = pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");
    const match = url.match(/github\.com\/([^/]+\/[^/]+)$/);
    if (match) return match[1];
  }

  return "nwparker/agent-slack";
}

function downloadToFile(urlString, destPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const req = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        headers: { "User-Agent": "agent-slack-postinstall" },
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          resolve(downloadToFile(res.headers.location, destPath));
          return;
        }
        if (status < 200 || status >= 300) {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8").slice(0, 4000);
            reject(new Error(`download failed (${status}) for ${urlString}\n${body}`));
          });
          return;
        }

        const file = fs.createWriteStream(destPath, { mode: 0o755 });
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
        file.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function main() {
  if (process.env.AGENT_SLACK_SKIP_DOWNLOAD === "1") {
    log("agent-slack: postinstall download skipped (AGENT_SLACK_SKIP_DOWNLOAD=1).");
    return;
  }

  if (!have("node")) {
    err("agent-slack: node not found; skipping native binary download.");
    return;
  }

  const asset = resolveAssetName();
  const version = getPackageVersion();
  const repo = getRepo();

  const baseUrl = `https://github.com/${repo}/releases/download/v${version}`;
  const url = `${baseUrl}/${asset}`;

  const nativeDir = path.join(__dirname, "..", "bin", "native");
  const destPath = path.join(nativeDir, asset);

  fs.mkdirSync(nativeDir, { recursive: true });

  if (fs.existsSync(destPath)) {
    return;
  }

  log(`agent-slack: downloading ${asset}...`);
  await downloadToFile(url, destPath);

  try {
    fs.chmodSync(destPath, 0o755);
  } catch {
    // ignore
  }
}

main().catch((e) => {
  err(`agent-slack: ${e && e.message ? e.message : String(e)}`);
  err("agent-slack: install will continue, but the CLI may not run until the binary is available.");
});
