import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("validates the migration operator helper against isolated SQLite and HTTP fixtures", () => {
  const result = execFileSync("python", [resolve("scripts/tests/test_apply_eod_publication_migration.py")], {
    encoding: "utf8", windowsHide: true, timeout: 30_000,
  });
  expect(result).toBe("");
});
