import { afterEach,describe,expect,it } from "vitest";
import { createEodAdmission,estimateEodQueries,type EodSql } from "../src/eod-d1-rest";
import { createSqliteD1 } from "./helpers/sqlite-d1";

describe("full-population fixed query admission",{timeout:30_000},() => {
  let db:ReturnType<typeof createSqliteD1>|undefined;
  afterEach(() => db?.dispose());
  const rows=(n:number) => JSON.stringify(Array.from({length:n},(_,i) => `S${i}`));
  const promotion=(removed:number,added:number):EodSql[] => [
    {sql:"DELETE FROM universe_symbols /* eod-universe-promote-delete */",params:["u",rows(removed)]},
    {sql:"INSERT INTO universe_symbols SELECT value FROM json_each(?) /* eod-universe-promote-insert */",params:["u",rows(added)]},
    ...["pointer","active","supersede"].map((marker) => ({sql:`UPDATE universe_versions SET status=? /* eod-universe-promote-${marker} */`,params:[]})),
  ];
  it("admits the bounded atomic cold membership transaction including index writes",async () => {
    db=createSqliteD1();db.migrate("ops-migrations");
    const queries=promotion(0,6000);
    expect(estimateEodQueries(queries)).toEqual({reads:36160,writes:18040});
    const admission=createEodAdmission(db.db,"cold-membership",{now:() => new Date("2026-09-08T20:30:00Z")});
    const settle=await admission(queries);
    await settle({rowsRead:30_000,rowsWritten:18_020,sizeAfter:100_000_000});await admission.flush();
    expect(await db.db.prepare("SELECT rows_written FROM eod_usage").first()).toEqual({rows_written:18_032});
  });
  it("does not grant the larger envelope to arbitrary or oversized mutations",async () => {
    db=createSqliteD1();db.migrate("ops-migrations");
    const admission=createEodAdmission(db.db,"unsafe-batch");
    await expect(admission(promotion(3000,6000))).rejects.toThrow("promotion-too-large");
    const changed=promotion(0,6000);changed[4].sql="UPDATE other SET value=?";
    await expect(admission(changed)).rejects.toThrow("eod-query-exceeds-bounded-reservation");
    expect(() => estimateEodQueries([{sql:"INSERT INTO universe_version_members SELECT value FROM json_each(?) /* eod-universe-stage */",params:["u",rows(401)]}]))
      .toThrow("invalid-batch");
  });
  it("reserves full SIP/Yahoo source manifests instead of assuming a small publication",() => {
    const manifest=JSON.stringify(Array.from({length:12000},(_,i) => ({feed:i%2 ? "sip":"yahoo-eod",ticker:`S${i}`,revision:5})));
    expect(estimateEodQueries([{sql:"UPDATE eod_publications SET status='accepted' WHERE NOT EXISTS (SELECT 1 LEFT JOIN eod_input_revisions actual ON 1=1)",params:["id",manifest]}]))
      .toEqual({reads:48064,writes:8});
    expect(() => estimateEodQueries([{sql:"SELECT 1 LEFT JOIN eod_input_revisions actual ON 1=1",params:["invalid"]}]))
      .toThrow("invalid-manifest");
  });
});
