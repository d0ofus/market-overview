import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadEodMemberships } from "../src/eod";
import { assessEodMembershipEvidence } from "../src/eod-membership-evidence";
import type { Env } from "../src/types";
import { createSqliteD1 } from "./helpers/sqlite-d1";

describe("scoped historical membership reads against real SQLite", { timeout: 20_000 }, () => {
  let market: ReturnType<typeof createSqliteD1>, ops: ReturnType<typeof createSqliteD1>;
  beforeEach(() => {
    market = createSqliteD1(); ops = createSqliteD1();
    market.migrate("market-data-migrations"); ops.migrate("ops-migrations");
  }, 30_000);
  afterEach(() => { market.dispose(); ops.dispose(); vi.useRealTimers(); });

  it("loads all five complete populations while excluding future and unrelated versions", async () => {
    const populations = [["sp500-core", 500], ["nasdaq-core", 2500], ["nyse-core", 1500],
      ["russell2000-core", 1800], ["overall-market-proxy", 4000]] as const;
    for (const [universe, count] of populations) {
      await market.db.prepare("INSERT INTO universes(id,name,active_version_id) VALUES(?,?,?)")
        .bind(universe, universe, `${universe}:future`).run();
      await market.db.prepare(`INSERT INTO universe_versions
        (id,universe_id,source,source_type,source_as_of_date,status,member_count,created_at,promoted_at)
        VALUES(?,?,'official','official','2026-09-08','superseded',?,'2026-09-07 20:00:00','2026-09-07 20:00:00'),
          (?,?,'future','official','2026-09-09','active',?,'2026-09-09 20:00:00','2026-09-09 20:00:00')`)
        .bind(`${universe}:past`, universe, count, `${universe}:future`, universe, count).run();
      const tickers = Array.from({length: count}, (_, index) => `T${String(index).padStart(5, "0")}`);
      await market.db.prepare(`INSERT INTO universe_version_members(version_id,ticker)
        SELECT ?,value FROM json_each(?) UNION ALL SELECT ?,value FROM json_each(?)`)
        .bind(`${universe}:past`, JSON.stringify(tickers), `${universe}:future`, JSON.stringify(tickers)).run();
    }
    market.script(`INSERT INTO universes(id,name,active_version_id) VALUES('unrelated','Other','unrelated:past');
      INSERT INTO universe_versions(id,universe_id,source,status,member_count,created_at)
      VALUES('unrelated:past','unrelated','other','active',1,'2026-09-07 20:00:00');
      INSERT INTO universe_version_members(version_id,ticker) VALUES('unrelated:past','EXCLUDED');`);
    const result = await loadEodMemberships({DB: market.db, MARKET_DATA_DB: market.db, OPS_DB: ops.db} as Env, "2026-09-08");
    expect(result).toHaveLength(5);
    for (const [universe, count] of populations) {
      const row = result.find((membership) => membership.universeId === universe)!;
      expect(row.versionId).toBe(`${universe}:past`);
      expect(row.members).toHaveLength(count);
      expect(row.source).toBe("official");
    }
    expect(result.flatMap((row) => row.members)).not.toContain("EXCLUDED");
  }, 30_000);

  it("includes NY evening promotions after UTC midnight but excludes the next NY day's version", async () => {
    await market.db.prepare("INSERT INTO universes(id,name,active_version_id) VALUES('sp500-core','S&P','late-evening')").run();
    const insertVersion = async (id: string, date: string, promoted: string) => {
      await market.db.prepare(`INSERT INTO universe_versions
        (id,universe_id,source,source_type,source_as_of_date,status,member_count,created_at,promoted_at)
        VALUES(?,'sp500-core','verified public proxy','public-index-constituents-proxy',?,'active',500,?,?)`)
        .bind(id, date, promoted, promoted).run();
      await market.db.prepare(`INSERT INTO universe_version_members(version_id,ticker)
        SELECT ?,value FROM json_each(?)`).bind(id, JSON.stringify(Array.from({ length: 500 }, (_, index) => `${id}${index}`))).run();
    };
    await insertVersion("late-evening", "2026-09-08", "2026-09-09 00:15:00");
    await ops.db.prepare(`INSERT INTO universe_source_sync_state
      (source_key,status,source_label,source_type,source_as_of_date,last_verified_at)
      VALUES('universe:sp500-core','ok','verified tonight','public-index-constituents-proxy','2026-09-08','2026-09-09 00:15:00')`).run();
    const env = { DB: market.db, MARKET_DATA_DB: market.db, OPS_DB: ops.db } as Env;
    const evening = await loadEodMemberships(env, "2026-09-08");
    expect(evening[0]).toMatchObject({ versionId: "late-evening", verifiedAt: "2026-09-09 00:15:00" });
    expect(evening[0]?.members).toHaveLength(500);

    await insertVersion("next-day", "2026-09-09", "2026-09-09T04:00:00Z");
    await market.db.prepare("UPDATE universes SET active_version_id='next-day' WHERE id='sp500-core'").run();
    await market.db.prepare("UPDATE universe_versions SET status='superseded' WHERE id='late-evening'").run();
    await ops.db.prepare("UPDATE universe_source_sync_state SET source_as_of_date='2026-09-09',last_verified_at='2026-09-09 04:00:00'").run();
    expect((await loadEodMemberships(env, "2026-09-08"))[0]).toMatchObject({
      versionId: "late-evening", sourceAsOfDate: null, verifiedAt: "2026-09-09 00:15:00",
    });
    expect((await loadEodMemberships(env, "2026-09-09"))[0]).toMatchObject({ versionId: "next-day", sourceAsOfDate: null });
  });

  it("uses a real dated issuer snapshot collected later while retaining the earlier verified S&P observation", async () => {
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-09-11T06:00:00Z"));
    const insert = async (universe:string,id:string,type:string,date:string|null,observed:string,count:number,status="active") => {
      await market.db.prepare("INSERT OR IGNORE INTO universes(id,name,active_version_id) VALUES(?,?,?)").bind(universe,universe,id).run();
      await market.db.prepare(`INSERT INTO universe_versions(id,universe_id,source,source_type,source_as_of_date,status,member_count,created_at,promoted_at)
        VALUES(?,?,'verified source',?,?,?,?,?,?)`).bind(id,universe,type,date,status,count,observed,observed).run();
      await market.db.prepare("INSERT INTO universe_version_members(version_id,ticker) SELECT ?,value FROM json_each(?)")
        .bind(id,JSON.stringify(Array.from({length:count},(_,i)=>`T${i}`))).run();
    };
    await insert("sp500-core","sp-sep09","wikipedia-derived-public-proxy","2026-09-09","2026-09-09 12:43:47",503,"superseded");
    await insert("sp500-core","sp-sep11","wikipedia-derived-public-proxy",null,"2026-09-11 05:48:27",503);
    await market.db.prepare("UPDATE universes SET active_version_id='sp-sep11' WHERE id='sp500-core'").run();
    await insert("russell2000-core","iwm-sep09","official-etf-holdings-proxy","2026-09-09","2026-09-11 05:48:27",1949);
    await ops.db.prepare(`INSERT INTO universe_source_sync_state(source_key,status,source_label,source_type,source_as_of_date,last_verified_at)
      VALUES('universe:sp500-core','ok','newly observed proxy','wikipedia-derived-public-proxy',NULL,'2026-09-11 05:48:27'),
        ('universe:russell2000-core','ok','issuer-dated set','official-etf-holdings-proxy','2026-09-09','2026-09-11 05:48:27')`).run();
    const env={DB:market.db,MARKET_DATA_DB:market.db,OPS_DB:ops.db} as Env;
    const memberships=await loadEodMemberships(env,"2026-09-10"),sp=memberships.find(row=>row.universeId==="sp500-core")!,
      iwm=memberships.find(row=>row.universeId==="russell2000-core")!;
    expect(sp).toMatchObject({versionId:"sp-sep09",sourceAsOfDate:null,verifiedAt:"2026-09-09 12:43:47"});
    expect(iwm).toMatchObject({versionId:"iwm-sep09",sourceAsOfDate:"2026-09-09",verifiedAt:"2026-09-11 05:48:27"});
    const calendar=["2026-09-02","2026-09-03","2026-09-04","2026-09-08","2026-09-09","2026-09-10"];
    for(const member of [sp,iwm])expect(assessEodMembershipEvidence(member,"2026-09-10",calendar))
      .toMatchObject({publishable:true,ageSessions:1,degraded:true});
    expect(await market.db.prepare("SELECT source_as_of_date AS date,promoted_at AS observed FROM universe_versions WHERE id='sp-sep09'").first())
      .toEqual({date:"2026-09-09",observed:"2026-09-09 12:43:47"});

    // A future effective set cannot displace the eligible issuer snapshot.
    await insert("russell2000-core","iwm-future","official-etf-holdings-proxy","2026-09-11","2026-09-11 05:48:27",1949);
    await market.db.prepare("UPDATE universes SET active_version_id='iwm-future' WHERE id='russell2000-core'").run();
    expect((await loadEodMemberships(env,"2026-09-10")).find(row=>row.universeId==="russell2000-core")?.versionId).toBe("iwm-sep09");
    await market.db.prepare("UPDATE universe_versions SET status='rejected' WHERE id='sp-sep09'").run();
    expect((await loadEodMemberships(env,"2026-09-10")).find(row=>row.universeId==="sp500-core")).toBeUndefined();
  });
});
