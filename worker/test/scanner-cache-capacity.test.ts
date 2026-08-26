import { describe, expect, it } from "vitest";
import { loadScannerCacheCapacity } from "../src/scans-page-service";
import type { Env } from "../src/types";

function capacityEnv(pageCount: number, pageSize: number, thresholds: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    SCANNER_CACHE_DB: {
      prepare(sql: string) {
        return { async first() { return sql.includes("page_count") ? { page_count: pageCount } : { page_size: pageSize }; } };
      },
    } as unknown as D1Database,
    ...thresholds,
  };
}

describe("scanner cache capacity policy", () => {
  it("uses the configured warning and halt thresholds", async () => {
    await expect(loadScannerCacheCapacity(capacityEnv(9, 10, {
      SCANNER_CACHE_WARN_BYTES: "100", SCANNER_CACHE_HALT_BYTES: "200",
    }))).resolves.toMatchObject({ status: "ok", sizeBytes: 90, warnBytes: 100, haltBytes: 200 });
    await expect(loadScannerCacheCapacity(capacityEnv(10, 10, {
      SCANNER_CACHE_WARN_BYTES: "100", SCANNER_CACHE_HALT_BYTES: "200",
    }))).resolves.toMatchObject({ status: "warning", sizeBytes: 100 });
    await expect(loadScannerCacheCapacity(capacityEnv(20, 10, {
      SCANNER_CACHE_WARN_BYTES: "100", SCANNER_CACHE_HALT_BYTES: "200",
    }))).resolves.toMatchObject({ status: "halt", sizeBytes: 200 });
  });

  it("reports unavailable without the scanner binding and retains default thresholds", async () => {
    await expect(loadScannerCacheCapacity({ DB: {} as D1Database })).resolves.toEqual({
      status: "unavailable", sizeBytes: null, warnBytes: 425_000_000, haltBytes: 475_000_000,
    });
  });
});
