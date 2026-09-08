import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getStoredHoldingStats } from "../src/eod-holdings-quotes";
import type { Env } from "../src/types";
import { createSqliteD1 } from "./helpers/sqlite-d1";

describe("stored holding quotes against migrated SQLite", () => {
  let storage: ReturnType<typeof createSqliteD1>;
  let env: Env;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2025-01-10T21:30:00Z"));
    storage=createSqliteD1(); storage.migrate("market-data-migrations");
    env={DB:storage.db,MARKET_DATA_DB:storage.db,ALPACA_DAILY_FEED:"sip"} as Env;
    storage.script(`INSERT INTO market_calendar_refresh_state(id,covered_start,covered_end,verified_at)
      VALUES('default','2025-01-01','2026-12-31','2025-01-10T20:00:00Z');
      INSERT INTO market_calendar_sessions(session_date,open_at,close_at,source) VALUES
      ('2025-01-07','09:30','16:00','alpaca-calendar'),('2025-01-08','09:30','16:00','alpaca-calendar'),
      ('2025-01-10','09:30','16:00','alpaca-calendar'),('2025-01-13','09:30','16:00','alpaca-calendar'),
      ('2026-11-25','09:30','16:00','alpaca-calendar'),('2026-11-27','09:30','13:00','alpaca-calendar'),
      ('2026-11-30','09:30','16:00','alpaca-calendar');`);
  },30_000);
  afterEach(() => {storage?.dispose();vi.useRealTimers();vi.unstubAllGlobals();});
  async function bars(rows:Array<[string,string,number,string?,string?]>) {
    const statements=rows.map(([ticker,date,close,provider="alpaca",adjustment="split"]) => storage.db.prepare(`INSERT INTO alpaca_daily_bars(feed,ticker,date,o,h,l,c,volume,source_provider,adjustment)
      VALUES('sip',?,?,?,?,?,?,100,?,?)`).bind(ticker,date,close,close,close,close,provider,adjustment));
    await storage.db.batch(statements);
  }
  it("returns all105 holdings with exact cached-session returns despite an exceptional closure and a future bar", async () => {
    const tickers=Array.from({length:105},(_,index) => `T${index.toString().padStart(3,"0")}`);
    await bars(tickers.flatMap((ticker):Array<[string,string,number]> => [[ticker,"2025-01-08",100],[ticker,"2025-01-10",110]]));
    await bars([["T104","2025-01-13",999]]);
    const fetcher=vi.fn();vi.stubGlobal("fetch",fetcher);
    const result=await getStoredHoldingStats(env,tickers);
    expect(result.size).toBe(105);
    expect(result.get("T104")).toMatchObject({lastPrice:110,barDate:"2025-01-10",source:"alpaca:sip:split"});
    // Jan9 is absent from the actual exchange calendar: Jan8 is the exact predecessor.
    expect(result.get("T104")?.change1d).toBeCloseTo(10);
    expect(result.get("T000")?.change1d).toBeCloseTo(10);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("never skips the exact predecessor, prices a non-session, or trusts a pending adjustment", async () => {
    await bars([["GAP","2025-01-07",90],["GAP","2025-01-10",110],
      ["CLOSED","2025-01-08",100],["CLOSED","2025-01-09",999],
      ["REPAIR","2025-01-08",100],["REPAIR","2025-01-10",110],
      ["RAW","2025-01-10",110,"alpaca","raw"]]);
    await storage.db.prepare("INSERT INTO eod_adjustment_repairs(feed,ticker,status,start_date,updated_at) VALUES('sip','REPAIR','pending','2025-01-01','2025-01-10T21:00:00Z')").run();
    const result=await getStoredHoldingStats(env,["GAP","CLOSED","REPAIR","RAW","MISSING"]);
    expect(result.get("GAP")).toMatchObject({lastPrice:110,change1d:null,barDate:"2025-01-10"});
    expect(result.get("CLOSED")).toMatchObject({lastPrice:100,barDate:"2025-01-08"});
    for(const ticker of ["REPAIR","RAW","MISSING"]) expect(result.get(ticker)).toEqual({lastPrice:null,change1d:null,barDate:null,source:null});
  });
  it("uses the actual early close and leaves all values unavailable when calendar coverage expires", async () => {
    await bars([["AAA","2026-11-25",100],["AAA","2026-11-27",110],["AAA","2026-11-30",999]]);
    vi.setSystemTime(new Date("2026-11-27T17:55:00Z"));
    expect((await getStoredHoldingStats(env,["AAA"])).get("AAA")?.barDate).toBe("2026-11-25");
    vi.setSystemTime(new Date("2026-11-27T18:05:00Z"));
    const afterClose=(await getStoredHoldingStats(env,["AAA"])).get("AAA");
    expect(afterClose?.barDate).toBe("2026-11-27");expect(afterClose?.change1d).toBeCloseTo(10);
    await storage.db.prepare("UPDATE market_calendar_refresh_state SET covered_end='2026-11-26'").run();
    const unavailable=await getStoredHoldingStats(env,["AAA","BBB"]);
    expect(unavailable.size).toBe(2);
    for(const value of unavailable.values()) expect(value).toEqual({lastPrice:null,change1d:null,barDate:null,source:null});
  });
});
