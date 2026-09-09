import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("checks offline archive-first capacity analysis with the real archive codec", () => {
  const result = execFileSync("python", [resolve("scripts/tests/test_analyze_eod_storage.py")], {
    encoding: "utf8", windowsHide: true, timeout: 45_000,
  });
  expect(result).toBe("");
}, 50_000);
