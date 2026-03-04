import { cpSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const rootDir = process.cwd();
const sourceDir = resolve(rootDir, "web", ".next");
const targetDir = resolve(rootDir, ".next");

if (!existsSync(sourceDir)) {
  console.error(`Expected Next output at ${sourceDir}, but it was not found.`);
  process.exit(1);
}

if (existsSync(targetDir)) {
  rmSync(targetDir, { recursive: true, force: true });
}

cpSync(sourceDir, targetDir, { recursive: true });
console.log(`Synced ${sourceDir} -> ${targetDir}`);
