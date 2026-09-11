import { describe, expect, it, vi } from "vitest";
import { refreshOverviewCurrentData } from "../src/overview-current-data";
import { prepareStorageSourceFence } from "../src/market-storage-fence";
import type { Env } from "../src/types";
import { createSqliteD1 } from "./helpers/sqlite-d1";

describe("Overview refresh ownership with storage guards", () => {
  it("does not refresh after a competing insert wins even though its BEFORE guard reports a change", async () => {
    const market = createSqliteD1();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected provider call"));
    try {
      market.migrate("market-data-migrations");
      const guards = (await prepareStorageSourceFence(market.db)).statements
        .filter((statement) => statement.sql.includes('ON "overview_current_refresh_jobs"'));
      expect(guards).toHaveLength(3);
      market.script(guards.map((statement) => statement.sql).join("\n"));

      let raced = false;
      let losingInsert: D1Result | null = null;
      const wrap = (sql: string, statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
        get(target, property) {
          if (property === "bind") return (...params: unknown[]) => wrap(sql, target.bind(...params));
          if (property === "first" && sql.includes("FROM overview_current_refresh_jobs")) return async () => {
            const previous = await target.first();
            if (!raced) {
              expect(previous).toBeNull();
              raced = true;
              await market.db.prepare(`INSERT INTO overview_current_refresh_jobs
                (config_id,session_date,status,attempt_count,requested_tickers,cycle_id,cycle_started_at,
                  lease_token,lease_expires_at,fresh_tickers)
                VALUES('default','2026-09-10','running',1,1,'winning-cycle','2026-09-10T20:30:00Z',
                  'winning-token','2026-09-10T20:34:00Z',1)`).run();
            }
            return previous;
          };
          if ((property === "run" || property === "all") && sql.includes("INSERT INTO overview_current_refresh_jobs")) return async () => {
            const result = await target.all();
            losingInsert = result;
            return result;
          };
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const marketDb = {
        ...market.db,
        prepare: (sql: string) => wrap(sql, market.db.prepare(sql)),
      } as D1Database;
      const core = { prepare: () => ({ bind: () => ({ all: async () => ({
        results: [{ ticker: "AAA", exchange: "NASDAQ" }],
      }) }) }) } as unknown as D1Database;
      const result = await refreshOverviewCurrentData({ DB: core, MARKET_DATA_DB: marketDb } as Env,
        "default", "2026-09-10", { now: new Date("2026-09-10T20:30:00Z") });

      expect(losingInsert).toMatchObject({ results: [], meta: { changes: 1 } });
      expect(result).toMatchObject({ status: "running", freshTickers: 1,
        nextAttemptAt: "2026-09-10T20:34:00Z", rows: [] });
      expect(await market.db.prepare(`SELECT lease_token,cycle_id,attempt_count,status
        FROM overview_current_refresh_jobs WHERE config_id='default' AND session_date='2026-09-10'`).first())
        .toEqual({ lease_token: "winning-token", cycle_id: "winning-cycle", attempt_count: 1, status: "running" });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      market.dispose();
    }
  }, 20_000);
});
