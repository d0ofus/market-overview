import { describe, expect, it } from "vitest";
import { createEodAdmission, estimateEodQueries } from "../src/eod-d1-rest";
import { resolveEodBudgetProfile } from "../src/eod-budget-profile";
import { createSqliteD1 } from "./helpers/sqlite-d1";

const sql = "SELECT feed,ticker,calendar_year,block_id,previous_block_id,updated_at FROM market_history_block_pointers WHERE feed=? AND ticker=? AND calendar_year=?";
const batch = (marked: boolean) => Array.from({length:8}, (_, index) => ({
  sql: sql + (marked ? " /* storage-archive-point-read */" : ""), params: ["sip", `TEST${index}`, 2026],
}));

describe("storage point-read admission", {timeout:30_000}, () => {
  it("keeps range queries conservatively reserved while bounding eight reviewed point reads", () => {
    expect(estimateEodQueries(batch(true))).toEqual({reads:512,writes:0});
    expect(estimateEodQueries(batch(false))).toEqual({reads:200_000,writes:0});
    expect(estimateEodQueries([{sql:"SELECT calendar_year FROM market_history_blocks WHERE ticker=?",params:["TEST"]}]))
      .toEqual({reads:25_000,writes:0});
  });

  it("reuses paid credit across point batches and still settles actual usage and rejects overruns", async () => {
    const storage=createSqliteD1(),now=new Date("2026-09-11T07:00:00Z");
    try {
      storage.migrate("ops-migrations");
      storage.script(`WITH RECURSIVE days(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM days WHERE n<30)
        INSERT INTO eod_account_usage(usage_date,rows_read,rows_written,sampled_at)
        SELECT date('2026-09-11','-'||n||' days'),0,0,'2026-09-11T07:00:00.000Z' FROM days;`);
      for (const marked of [false,true]) {
        const runId=marked ? "bounded-points" : "old-calendar-estimate";
        const admit=createEodAdmission(storage.db,runId,{profile:resolveEodBudgetProfile("paid"),now:()=>now,writeCredit:500});
        for (let index=0;index<8;index++) {
          const settle=await admit(batch(marked));
          await settle({rowsRead:16,rowsWritten:0,sizeAfter:100_000_000});
        }
        await admit.flush();
        expect(await storage.db.prepare("SELECT COUNT(*) AS n FROM eod_budget_reservations WHERE run_id=? AND settled=1")
          .bind(runId).first<number>("n")).toBe(marked ? 1 : 8);
      }
      expect(await storage.db.prepare("SELECT rows_read,rows_written,reserved_reads,reserved_writes FROM eod_usage").first())
        .toEqual({rows_read:9*1_024+16*16,rows_written:9*32,reserved_reads:0,reserved_writes:0});
      const overrun=createEodAdmission(storage.db,"overrun",{profile:resolveEodBudgetProfile("paid"),now:()=>now});
      const settle=await overrun(batch(true));
      await expect(settle({rowsRead:513,rowsWritten:0,sizeAfter:100_000_000})).rejects.toThrow("query-budget-estimate-exceeded");
      await expect(overrun(batch(true))).rejects.toThrow("query-budget-estimate-exceeded");
      await overrun.flush();
    } finally {storage.dispose();}
  });
});
