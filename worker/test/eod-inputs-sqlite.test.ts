import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";
import { createSqliteD1 } from "./helpers/sqlite-d1";

vi.mock("../src/db",() => ({loadConfig:vi.fn(async () => ({id:"default",sections:[{groups:[{items:[{ticker:"QQQ",enabled:true}]}]}]}))}));
vi.mock("../src/eod",() => ({refreshBreadthUniverseMemberships:vi.fn(),loadEodMemberships:vi.fn(async () => [
  {universeId:"sp500-core",versionId:"sp",members:["AAPL"]},
])}));
import { loadEodInputs } from "../src/eod-runner";

describe("first-run catalog binding against separate actual schemas",() => {
  let core:ReturnType<typeof createSqliteD1>,market:ReturnType<typeof createSqliteD1>;
  beforeEach(async () => {
    core=createSqliteD1();market=createSqliteD1();
    core.script(readFileSync(resolve("migrations/0001_init.sql"),"utf8")+readFileSync(resolve("migrations/0032_symbol_directory.sql"),"utf8"));
    market.migrate("market-data-migrations");
    core.script(`INSERT INTO symbols(ticker,name,asset_class,is_active,catalog_managed) VALUES
      ('CATALOG_ONLY','Other workflow equity','equity',1,1),('INACTIVE','Inactive','equity',0,1),
      ('MANUAL','Manual row','equity',1,0),('CRYPTO','Non-equity','crypto',1,1);`);
    const dates=Array.from({length:410},(_,i) => new Date(Date.UTC(2025,0,1+i)).toISOString().slice(0,10));
    await market.db.prepare(`INSERT INTO market_calendar_sessions(session_date,open_at,close_at,source)
      SELECT value,'09:30','16:00','fixture' FROM json_each(?)`).bind(JSON.stringify(dates)).run();
  });
  afterEach(() => {core.dispose();market.dispose();});
  it("includes catalog symbols outside every Overview row and breadth membership",async () => {
    const inputs=await loadEodInputs({DB:core.db,MARKET_DATA_DB:market.db} as Env,"2026-02-14");
    expect(inputs.tickers).toEqual(["QQQ","SPY","AAPL","CATALOG_ONLY"]);
    expect(inputs.calendarDates).toHaveLength(410);
  });
});
