import { describe, expect, it } from "vitest";
import { cleanupScannerCacheRunData } from "../src/scans-page-service";
import type { Env } from "../src/types";

type RunState = { id: string; childRows: number; deleted: boolean };

function retentionEnv(run: RunState): Env & { limits: number[] } {
  const limits: number[] = [];
  const scannerDb = {
    prepare(sql: string) {
      const bound = (args: unknown[]) => ({
        async first<T>() {
          if (sql.includes("SELECT id, run_type as runType")) {
            return (!run.deleted ? { id: run.id, runType: "relative-strength" } : null) as T;
          }
          return null as T;
        },
        async all<T>() {
          return { results: [] as T[] };
        },
        async run() {
          if (sql.includes("DELETE FROM rs_scan_run_tickers")) {
            const limit = Number(args[1]);
            limits.push(limit);
            const deleted = Math.min(run.childRows, limit);
            run.childRows -= deleted;
            return { meta: { rows_written: deleted } };
          }
          if (sql.includes("DELETE FROM scanner_cache_scan_run_queue")) {
            return { meta: { rows_written: 0 } };
          }
          if (sql.includes("DELETE FROM rs_scan_runs")) {
            run.deleted = true;
            return { meta: { rows_written: 1 } };
          }
          return { meta: { rows_written: 0 } };
        },
      });
      return {
        bind(...args: unknown[]) {
          return bound(args);
        },
        first<T>() {
          return bound([]).first<T>();
        },
        all<T>() {
          return bound([]).all<T>();
        },
        run() {
          return bound([]).run();
        },
      };
    },
  } as unknown as D1Database;
  return { DB: {} as D1Database, SCANNER_CACHE_DB: scannerDb, limits };
}

describe("scanner cache retention", () => {
  it("deletes child rows in bounded resumable batches before deleting the run", async () => {
    const run = { id: "old-rs-run", childRows: 5_500, deleted: false };
    const env = retentionEnv(run);

    const first = await cleanupScannerCacheRunData(env, 7, 5_000);
    expect(first).toMatchObject({
      childRowsDeleted: 5_000,
      completedRunsDeleted: 0,
      rowsWritten: 5_000,
      cursor: "old-rs-run",
      stopReason: "write_budget",
    });
    expect(run).toEqual({ id: "old-rs-run", childRows: 500, deleted: false });
    expect(env.limits.every((limit) => limit <= 1_000)).toBe(true);

    const second = await cleanupScannerCacheRunData(env, 7, 5_000);
    expect(second).toMatchObject({ childRowsDeleted: 500, completedRunsDeleted: 1, rowsWritten: 501 });
    expect(run.deleted).toBe(true);
  });

  it("encodes active-run and latest-completed protection in the candidate query", async () => {
    let selectionSql = "";
    const env = {
      DB: {} as D1Database,
      SCANNER_CACHE_DB: {
        prepare(sql: string) {
          if (sql.includes("SELECT id, run_type as runType")) selectionSql = sql;
          return {
            bind() {
              return { async first() { return null; }, async run() { return { meta: { rows_written: 0 } }; } };
            },
          };
        },
      } as unknown as D1Database,
    } as Env;

    await cleanupScannerCacheRunData(env);
    expect(selectionSql).toContain("status IN ('completed', 'failed', 'cancelled')");
    expect(selectionSql).toContain("latest.status = 'completed'");
    expect(selectionSql).toContain("rs_publications publication");
    expect(selectionSql).toContain("publication.run_id = r.id");
    expect(selectionSql).not.toContain("status NOT IN ('queued', 'running')");
  });
});
