#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCleanup } from "./cleanup-legacy-daily-bars-lib.mjs";

export * from "./cleanup-legacy-daily-bars-lib.mjs";

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  runCleanup().then((result) => {
    if (result.status === "paused") process.exitCode = 2;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
