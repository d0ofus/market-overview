import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("measures indexed publication growth from exact stored payloads in an isolated SQLite fixture", () => {
  const output = execFileSync("python", [resolve("scripts/tests/test_measure_eod_publication_growth.py")], {
    encoding: "utf8", windowsHide: true, timeout: 30_000,
  });
  expect(output).toBe("");
}, 35_000);
