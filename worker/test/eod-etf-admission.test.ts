import { afterEach, describe, expect, it } from "vitest";
import { createEodAdmission, estimateEodQueries, type EodSql } from "../src/eod-d1-rest";
import { resolveEodBudgetProfile } from "../src/eod-budget-profile";
import { createSqliteD1 } from "./helpers/sqlite-d1";

const now=new Date("2026-09-11T05:00:00Z");
function replacement(previous:number,count:number):EodSql[] {
  const payload=JSON.stringify(Array.from({length:count},(_,i)=>({id:`id${i}`,ticker:`T${i}`,assetType:"equity"})));
  return [
    {sql:"DELETE FROM etf_constituents WHERE etf_ticker=? AND ?=? /* etf-holdings-replace-delete */",params:["XLC","XLC",previous]},
    {sql:"INSERT INTO etf_constituents SELECT ?,?,?,value FROM json_each(?) /* etf-holdings-replace-insert */",params:["XLC",null,"official",payload]},
    {sql:"INSERT OR IGNORE INTO symbols SELECT value FROM json_each(?) /* etf-holdings-symbols-insert */",params:[payload]},
  ];
}
describe("bounded atomic holdings admission",()=>{
  let storage:ReturnType<typeof createSqliteD1>|undefined;
  afterEach(()=>storage?.dispose());
  const setup=()=>{storage=createSqliteD1();storage.migrate("ops-migrations");return storage.db;};
  it("scales credit with actual old and new counts, including every symbol index",()=>{
    expect(estimateEodQueries(replacement(24,24))).toEqual({reads:672,writes:480});
    expect(estimateEodQueries(replacement(10_000,10_000))).toEqual({reads:240_096,writes:180_048});
    expect(()=>estimateEodQueries(replacement(10_001,24))).toThrow("etf-holdings-invalid-batch");
    expect(()=>estimateEodQueries(replacement(0,10_001))).toThrow("etf-holdings-invalid-batch");
  });
  it("admits a full2000-row replacement on Free while retaining its daily write ceiling",async()=>{
    const db=setup(),queries=replacement(2_000,2_000),estimate=estimateEodQueries(queries);
    const admission=createEodAdmission(db,"holdings-free",{now:()=>now});
    const settle=await admission(queries);
    expect(await db.prepare("SELECT writes FROM eod_budget_reservations").first("writes")).toBe(estimate.writes+12);
    await settle({rowsRead:1_000,rowsWritten:30_000,sizeAfter:0});await admission.flush();
    const next=createEodAdmission(db,"holdings-next",{now:()=>now});
    await expect(next(queries)).rejects.toThrow("eod-d1-budget-exhausted");await next.flush();
  });
  it("admits the10k hard bound only with available Paid daily and rolling credit",async()=>{
    const db=setup();
    await db.batch(Array.from({length:31},(_,i)=>db.prepare("INSERT INTO eod_account_usage(usage_date,rows_read,rows_written,sampled_at) VALUES(?,0,0,?)")
      .bind(new Date(now.getTime()-i*86_400_000).toISOString().slice(0,10),now.toISOString())));
    const queries=replacement(10_000,10_000),estimate=estimateEodQueries(queries);
    const free=createEodAdmission(db,"holdings-free",{now:()=>now});
    await expect(free(queries)).rejects.toThrow("eod-d1-budget-exhausted");await free.flush();
    const paid=createEodAdmission(db,"holdings-paid",{now:()=>now,profile:resolveEodBudgetProfile("paid")});
    const settle=await paid(queries);
    expect(await db.prepare("SELECT writes FROM eod_budget_reservations").first("writes")).toBe(estimate.writes+32);
    await settle({rowsRead:estimate.reads,rowsWritten:estimate.writes,sizeAfter:0});await paid.flush();
  });
  it("does not extend generic or incomplete batches and rejects mismatched replacement payloads",async()=>{
    const db=setup(),admission=createEodAdmission(db,"holdings-invalid",{now:()=>now});
    await expect(admission(replacement(2_000,2_000).slice(0,2))).rejects.toThrow("eod-query-exceeds-bounded-reservation");
    const mismatched=replacement(2_000,2_000);mismatched[2].params[0]="[]";
    await expect(admission(mismatched)).rejects.toThrow("etf-holdings-invalid-batch");await admission.flush();
  });
});
