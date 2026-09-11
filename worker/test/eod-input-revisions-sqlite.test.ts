import { afterEach, describe, expect, it } from "vitest";
import { inputRevisions } from "../src/eod-runner";
import { estimateEodQueries } from "../src/eod-d1-rest";
import type { Env } from "../src/types";
import { createSqliteD1 } from "./helpers/sqlite-d1";

describe("bounded EOD revision reads on the production schema", () => {
  let storage: ReturnType<typeof createSqliteD1> | undefined;
  afterEach(() => storage?.dispose());

  it("probes both primary-key columns while preserving revisions and missing-feed zeros", async () => {
    storage = createSqliteD1();
    storage.migrate("market-data-migrations");
    storage.script(`WITH RECURSIVE population(n) AS (
      SELECT 0 UNION ALL SELECT n+1 FROM population WHERE n<6999
    ), feeds(feed) AS (VALUES('sip'),('yahoo-eod'),('iex'))
    INSERT INTO eod_input_revisions(feed,ticker,revision)
    SELECT feed,printf('S%05d',n),n+1 FROM population CROSS JOIN feeds;
    INSERT INTO eod_input_revisions(feed,ticker,revision) VALUES('sip','ONLYSIP',77);`);
    let capturedSql = "";
    const db = { prepare(sql: string) { capturedSql = sql; return storage!.db.prepare(sql); } } as D1Database;
    const tickers = ["MISSING", "ONLYSIP", ...Array.from({ length: 23 }, (_, index) => `S${String(index).padStart(5, "0")}`)];
    const actual = await inputRevisions({ MARKET_DATA_DB: db } as Env, tickers);
    const expected = tickers.flatMap((ticker) => ["sip", "yahoo-eod"].map((feed) => ({
      feed, ticker, revision: ticker === "MISSING" ? 0 : ticker === "ONLYSIP"
        ? (feed === "sip" ? 77 : 0) : Number(ticker.slice(1)) + 1,
    }))).sort((left, right) => `${left.feed}:${left.ticker}`.localeCompare(`${right.feed}:${right.ticker}`));
    expect(actual).toEqual(expected);
    expect(actual).toHaveLength(50);
    const plans = await storage.db.prepare(`EXPLAIN QUERY PLAN ${capturedSql}`)
      .bind(JSON.stringify(tickers)).all<{ detail: string }>();
    const revisionPlans = plans.results.filter((row) => row.detail.includes("eod_input_revisions"));
    expect(revisionPlans).toHaveLength(1);
    expect(revisionPlans[0].detail).toMatch(/SEARCH eod_input_revisions USING PRIMARY KEY \(feed=\? AND ticker=\?\)/);
    const legacy = await storage.db.prepare(`EXPLAIN QUERY PLAN SELECT feed,ticker,revision FROM eod_input_revisions
      WHERE ticker IN (SELECT value FROM json_each(?)) ORDER BY feed,ticker`).bind(JSON.stringify(tickers)).all<{ detail: string }>();
    expect(legacy.results.some((row) => row.detail === "SCAN eod_input_revisions")).toBe(true);
    expect(await storage.db.prepare("SELECT COUNT(*) AS count FROM eod_input_revisions").first("count")).toBe(21_001);
    // A local SQLite result count is not D1 billed-read telemetry. The actual
    // indexed query plan proves unrelated rows are excluded without increasing
    // the existing admission envelope to hide the former population scan.
    expect(estimateEodQueries([{ sql: capturedSql, params: [JSON.stringify(tickers)] }])).toEqual({ reads: 2_000, writes: 0 });
  });
});
