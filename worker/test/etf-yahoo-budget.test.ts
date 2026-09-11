import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncEtfConstituents } from "../src/etf";
import { meteredFetch } from "../src/provider-usage";
import type { Env } from "../src/types";
import { createSqliteD1 } from "./helpers/sqlite-d1";

const NOW = new Date("2026-09-11T07:00:00Z");
const OLD_FULL = "2026-09-01T23:00:00Z";
let sqlite: ReturnType<typeof createSqliteD1> | undefined;
function setup(used = 0): Env {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  sqlite = createSqliteD1();
  sqlite.script("CREATE TABLE symbols(ticker TEXT PRIMARY KEY,name TEXT,exchange TEXT,asset_class TEXT,sector TEXT,industry TEXT);\n"
    + ["0006_etf_watchlists_and_constituents.sql", "0009_etf_watchlist_source_url.sql", "0051_etf_sync_metadata.sql"]
      .map(name => readFileSync(`migrations/${name}`, "utf8")).join("\n")
    + readFileSync("ops-migrations/0001_market_ops.sql", "utf8")
    + `INSERT INTO provider_budget_counters(provider_key,window_kind,window_bucket,request_count) VALUES('yahoo','day','2026-09-11',${used});
       INSERT INTO etf_constituents(id,etf_ticker,constituent_ticker,weight,as_of_date,source)
         VALUES('old','TEST','OLD',100,'2026-09-01','official:issuer.test');
       INSERT INTO etf_constituent_sync_status(etf_ticker,last_synced_at,last_full_synced_at,status,source,coverage,source_tier,records_count)
         VALUES('TEST','${OLD_FULL}','${OLD_FULL}','ok','official:issuer.test','full','official',1);`);
  return { DB: sqlite.db, OPS_DB: sqlite.db, OPS_DB_REQUIRED: "true", YAHOO_REQUESTS_PER_DAY_HARD: "250" } as Env;
}
function yahooSuccess() {
  return Response.json({ quoteSummary: { result: [{ topHoldings: { holdings: [
    { symbol: "NEW", holdingName: "New holding", holdingPercent: { raw: 0.4 } },
  ] } }] } });
}
function provider(yahoo: () => Response | Promise<Response>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async input =>
    String(input).includes("query2.finance.yahoo.com") ? yahoo() : new Response("Unavailable", { status: 404 }));
}
async function counter(env: Env) {
  return env.OPS_DB!.prepare("SELECT request_count FROM provider_budget_counters WHERE provider_key='yahoo' AND window_kind='day' AND window_bucket='2026-09-11'").first<number>("request_count");
}
async function assertOldFull(env: Env) {
  expect(await env.DB.prepare("SELECT constituent_ticker,as_of_date FROM etf_constituents WHERE etf_ticker='TEST'").all())
    .toMatchObject({ results: [{ constituent_ticker: "OLD", as_of_date: "2026-09-01" }] });
  expect(await env.DB.prepare("SELECT last_full_synced_at FROM etf_constituent_sync_status WHERE etf_ticker='TEST'").first("last_full_synced_at"))
    .toBe(OLD_FULL);
}
afterEach(() => { sqlite?.dispose(); sqlite = undefined; vi.restoreAllMocks(); vi.useRealTimers(); });

describe("ETF Yahoo fallback shares the account-wide provider budget", () => {
  it("spaces concurrent holdings attempts and reserves both against the same daily counter", async () => {
    const env = setup(248), starts: number[] = [];
    provider(() => { starts.push(performance.now()); return yahooSuccess(); });
    await Promise.all([syncEtfConstituents(env, "TEST"), syncEtfConstituents(env, "TEST")]);
    expect(starts).toHaveLength(2);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(1_900);
    expect(await counter(env)).toBe(250);
    await assertOldFull(env);
  }, 20_000);

  it("charges the final permitted request and blocks a later retry without changing the full snapshot", async () => {
    const env = setup(249), fetcher = provider(yahooSuccess);
    await expect(syncEtfConstituents(env, "TEST")).resolves.toMatchObject({ skippedPartialOverwrite: true, coverage: "full", asOfDate: "2026-09-01" });
    expect(await counter(env)).toBe(250);
    await expect(syncEtfConstituents(env, "TEST")).rejects.toThrow("Provider budget exceeded for yahoo: 250/day");
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes("yahoo.com"))).toHaveLength(1);
    expect(await env.OPS_DB!.prepare("SELECT request_count,success_count FROM provider_usage_daily WHERE provider_key='yahoo' AND endpoint_key='etf-top-holdings' AND caller='etf-constituents'").first())
      .toEqual({ request_count: 1, success_count: 1 });
    await assertOldFull(env);
  }, 20_000);

  it("honors requests already reserved by the EOD price caller", async () => {
    const env = setup(249), fetcher = provider(yahooSuccess);
    await meteredFetch(env, "https://query2.finance.yahoo.com/v8/finance/chart/SPY", {},
      { providerKey: "yahoo", endpointKey: "eod-history", caller: "github-eod" });
    await expect(syncEtfConstituents(env, "TEST")).rejects.toThrow("Provider budget exceeded for yahoo: 250/day");
    expect(await counter(env)).toBe(250);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes("quoteSummary"))).toHaveLength(0);
    await assertOldFull(env);
  }, 20_000);

  it.each([401, 403, 429, 503])("records HTTP %s and charges an actual subsequent retry separately", async status => {
    const env = setup(248);
    let calls = 0;
    provider(() => ++calls === 1 ? new Response("Unavailable", { status }) : yahooSuccess());
    await expect(syncEtfConstituents(env, "TEST")).rejects.toThrow(`Yahoo topHoldings fetch failed (${status})`);
    await assertOldFull(env);
    await expect(syncEtfConstituents(env, "TEST")).resolves.toMatchObject({ skippedPartialOverwrite: true });
    expect(calls).toBe(2);
    expect(await counter(env)).toBe(250);
    expect(await env.OPS_DB!.prepare("SELECT request_count,success_count,error_count,rate_limited_count FROM provider_usage_daily WHERE endpoint_key='etf-top-holdings'").first())
      .toEqual({ request_count: 2, success_count: 1, error_count: 1, rate_limited_count: status === 429 ? 1 : 0 });
    await assertOldFull(env);
  }, 20_000);

  it("sends no Yahoo request when its required reservation database is missing", async () => {
    const env = setup();
    delete env.OPS_DB;
    const fetcher = provider(yahooSuccess);
    await expect(syncEtfConstituents(env, "TEST")).rejects.toThrow("Provider budget storage is unavailable for yahoo");
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes("yahoo.com"))).toHaveLength(0);
    await assertOldFull(env);
  }, 20_000);

  it("does not consume Yahoo capacity when a validated official source succeeds", async () => {
    const env = setup(250);
    const csv = "Date,Account Symbol,Stock Ticker,Security Description,Portfolio Weight %\n2026-09-10,MSOS,AAA,Example,50%\n2026-09-10,MSOS,BBB,Example B,50%";
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(csv, { headers: { "content-type": "text/csv" } }));
    await expect(syncEtfConstituents(env, "MSOS")).resolves.toMatchObject({ sourceTier: "official", coverage: "full", count: 2 });
    expect(await counter(env)).toBe(250);
    expect(fetcher.mock.calls.every(([url]) => String(url).includes("advisorshares.com"))).toBe(true);
    expect(await env.OPS_DB!.prepare("SELECT COUNT(*) AS count FROM provider_usage_daily WHERE provider_key='yahoo'").first("count")).toBe(0);
  }, 20_000);
});
