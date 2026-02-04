#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distEntrypoint = join(here, "..", "dist", "index.js");

if (existsSync(distEntrypoint)) {
  await import(pathToFileURL(distEntrypoint).href);
} else {
  await import("../src/index.ts");
}
