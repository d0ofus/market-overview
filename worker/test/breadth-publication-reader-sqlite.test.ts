import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBreadthDashboard } from "../src/breadth-dashboard-service";
import { EOD_METRICS_VERSION } from "../src/eod-metrics";
import { createSqliteD1 } from "./helpers/sqlite-d1";
import type { Env } from "../src/types";

const universes=["sp500-core","nasdaq-core","nyse-core","russell2000-core","overall-market-proxy"];

describe("bounded Breadth publication reader against SQLite", {timeout:20_000}, () => {
  let storage:ReturnType<typeof createSqliteD1>;
  beforeEach(() => {
    storage=createSqliteD1();storage.migrate("market-data-migrations");
    storage.script(`INSERT INTO market_calendar_refresh_state(id,covered_start,covered_end,verified_at)
      VALUES('default','2026-09-01','2026-09-30','2026-09-09T20:00:00.000Z');
      INSERT INTO market_calendar_sessions(session_date,open_at,close_at,source) VALUES
      ('2026-09-02','09:30','16:00','fixture'),('2026-09-03','09:30','16:00','fixture'),
      ('2026-09-04','09:30','16:00','fixture'),('2026-09-08','09:30','16:00','fixture'),
      ('2026-09-09','09:30','16:00','fixture');`);
  },30_000);
  afterEach(() => storage.dispose());
  async function publish(universe:string,date:string,revision=1,pointer=true) {
    const id=`${universe}:${date}:${revision}`;
    const payload={asOfDate:date,universeId:universe,methodologyVersion:EOD_METRICS_VERSION,
      advancers:300+revision,decliners:190-revision,unchanged:10,
      pctAbove20MA:null,pctAbove50MA:null,pctAbove200MA:null,new20DHighs:null,new20DLows:null,
      medianReturn1D:0,medianReturn5D:null,
      metrics:{memberCount:500,totalUniverseMembers:500,dataCoveragePct:100},
      membership:{versionId:`${universe}:frozen`,source:"frozen verified source",sourceAsOfDate:"2026-08-25",
        verifiedAt:date==="2026-09-09" ? "2026-09-08T21:00:00.000Z" : `${date}T21:00:00.000Z`},
      volumeCollection:{earliest:"2026-09-09T20:30:00.000Z",latest:"2026-09-09T20:35:00.000Z",observedCount:490,eligibleCount:500}};
    await storage.db.prepare(`INSERT INTO eod_publications(id,scope,session_date,revision,input_hash,methodology_version,
      payload_json,payload_codec,payload_base64,status,created_at) VALUES(?,?,?,?,?,? ,?,'gzip-json-v1','intentionally-not-gzip','accepted',?)`)
      .bind(id,`breadth:${universe}`,date,revision,id,EOD_METRICS_VERSION,JSON.stringify(payload),`${date}T22:00:00.000Z`).run();
    if (pointer) await storage.db.prepare(`INSERT INTO eod_publication_pointers(scope,publication_id,session_date,published_at)
      VALUES(?,?,?,?) ON CONFLICT(scope) DO UPDATE SET publication_id=excluded.publication_id,
      session_date=excluded.session_date,published_at=excluded.published_at`)
      .bind(`breadth:${universe}`,id,date,`${date}T22:00:00.000Z`).run();
  }

  it("uses complete SQL summaries, latest revisions inside the exchange window, and independent old heads", async () => {
    for (const universe of universes) {
      await publish(universe,"2026-09-04");
      await publish(universe,"2026-09-08");
      if (universe!=="nasdaq-core") await publish(universe,"2026-09-09");
    }
    await publish("sp500-core","2026-09-09",2);
    await publish("nasdaq-core","2026-09-03");
    const env={DB:storage.db,MARKET_DATA_DB:storage.db,EOD_READ_ENABLED:"true"} as Env;
    const dashboard=await loadBreadthDashboard(env,2,new Date("2026-09-09T22:00:00.000Z"));
    expect(dashboard.exchangeSessionDates).toEqual(["2026-09-08","2026-09-09"]);
    const sp=dashboard.universes.find((row) => row.universeId==="sp500-core")!;
    expect(sp.displayedSnapshot?.advancers).toBe(302);
    expect(sp.history.map((row) => [row.asOfDate,row.advancers])).toEqual([["2026-09-08",301],["2026-09-09",302]]);
    expect(sp.membership).toMatchObject({status:"published-version",verifiedAt:"2026-09-08T21:00:00.000Z",
      sourceAsOfDate:"2026-08-25",sourceAgeSessions:1,degraded:true});
    const nasdaq=dashboard.universes.find((row) => row.universeId==="nasdaq-core")!;
    expect(nasdaq.displayedAsOfSession).toBe("2026-09-03");
    expect(nasdaq.staleTradingSessions).toBe(3);
    expect(nasdaq.membership).toMatchObject({sourceAgeSessions:0,degraded:false});
    expect(nasdaq.history.map((row) => row.asOfDate)).toEqual(["2026-09-03","2026-09-08"]);
  });

  it("dates post-close membership verification in New York and rejects timestamps after publication or now", async () => {
    for (const universe of universes) await publish(universe, "2026-09-09");
    for (const [universe, verified, published] of [
      ["sp500-core", "2026-09-10 03:42:38", "2026-09-10T04:00:00.000Z"],
      ["russell2000-core", "2026-09-10T04:30:00.000Z", "2026-09-10T04:45:00.000Z"],
      ["nasdaq-core", "2026-09-10T06:00:00.000Z", "2026-09-10T07:00:00.000Z"],
      ["nyse-core", "2026-09-10T03:00:00.000Z", "2026-09-09T22:00:00.000Z"],
    ]) {
      await storage.db.prepare("UPDATE eod_publications SET payload_json=json_set(payload_json,'$.membership.verifiedAt',?),created_at=? WHERE id=?")
        .bind(verified, published, `${universe}:2026-09-09:1`).run();
    }
    const env = { DB: storage.db, MARKET_DATA_DB: storage.db, EOD_READ_ENABLED: "true" } as Env;
    const dashboard = await loadBreadthDashboard(env, 5, new Date("2026-09-10T05:00:00.000Z"));
    for (const universe of ["sp500-core", "russell2000-core"]) {
      expect(dashboard.universes.find(row => row.universeId === universe)?.membership).toMatchObject({ sourceAgeSessions: 0, degraded: false });
    }
    for (const universe of ["nasdaq-core", "nyse-core"]) {
      expect(dashboard.universes.find(row => row.universeId === universe)?.membership).toMatchObject({ sourceAgeSessions: null, degraded: true });
    }
  });
});
