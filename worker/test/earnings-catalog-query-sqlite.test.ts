import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { earningsDefaultEligibleListedEquitySql } from "../src/earnings-issue-filter";
import { createSqliteD1 } from "./helpers/sqlite-d1";

describe("earnings catalog lookup against real SQLite", () => {
  let storage: ReturnType<typeof createSqliteD1>;
  beforeEach(() => {
    storage = createSqliteD1();
    storage.script(`
      CREATE TABLE symbols(ticker TEXT PRIMARY KEY, is_active INTEGER, asset_class TEXT, catalog_managed INTEGER, listing_source TEXT);
      CREATE TABLE earnings_surprise_events(ticker TEXT, source_symbol TEXT, company_name TEXT, exchange TEXT, eps_surprise_pct REAL, report_date TEXT);
      INSERT INTO symbols VALUES('AAA',1,'equity',1,NULL),('bBb',1,'stock',0,'manual'),('CCC',0,'equity',1,NULL),('ETF',1,'etf',1,NULL),('NULLS',NULL,NULL,1,NULL);
      INSERT INTO earnings_surprise_events VALUES
        ('AAA','AAA','Alpha Corporation','NYSE',10,'2026-09-04'),
        ('BBB','BBB','Beta Corporation','NASDAQ',-2,'2026-09-04'),
        ('CCC','CCC','Inactive Corporation','NYSE',5,'2026-09-04'),
        ('ETF','ETF','Market ETF','NYSE',5,'2026-09-04'),
        ('MISSING','MISSING','Unknown Corporation','NYSE',5,'2026-09-04'),
        ('NULLS','NULLS','Null Metadata Corporation','AMEX',0,'2026-09-04'),
        ('AAA','AAA','Alpha Preferred Stock','NYSE',4,'2026-09-03');
    `);
  });
  afterEach(() => storage.dispose());

  const statusSql = () => `SELECT COUNT(*) as total,
    SUM(CASE WHEN eps_surprise_pct > 0 THEN 1 ELSE 0 END) as positive,
    SUM(CASE WHEN eps_surprise_pct < 0 THEN 1 ELSE 0 END) as negative,
    MAX(report_date) as latestReportDate, MIN(report_date) as earliestReportDate
    FROM earnings_surprise_events
    WHERE ${earningsDefaultEligibleListedEquitySql("earnings_surprise_events", { includeCatalog: true })}`;
  const migrate = () => storage.script(readFileSync(resolve("migrations/0102_earnings_catalog_lookup.sql"), "utf8"));

  it("uses an indexed correlated lookup and preserves mixed-case, manual, inactive and null metadata semantics", async () => {
    const before = await storage.db.prepare(statusSql()).first();
    const beforePlan = await storage.db.prepare(`EXPLAIN QUERY PLAN ${statusSql()}`).all<{ detail: string }>();
    expect(beforePlan.results.some((row) => row.detail.includes("SCAN catalog_symbol"))).toBe(true);
    migrate();
    migrate(); // Safe to replay the migration.
    const afterPlan = await storage.db.prepare(`EXPLAIN QUERY PLAN ${statusSql()}`).all<{ detail: string }>();
    expect(afterPlan.results.some((row) => row.detail.includes("SEARCH catalog_symbol USING INDEX idx_symbols_upper_ticker"))).toBe(true);
    expect(afterPlan.results.some((row) => row.detail.includes("SCAN catalog_symbol"))).toBe(false);
    expect(await storage.db.prepare(statusSql()).first()).toEqual(before);
    expect(before).toEqual({ total: 3, positive: 1, negative: 1, latestReportDate: "2026-09-04", earliestReportDate: "2026-09-04" });
  });

  it("preserves the existing no-active-catalog fallback", async () => {
    await storage.db.prepare("UPDATE symbols SET catalog_managed=0").run();
    const before = await storage.db.prepare(statusSql()).first();
    migrate();
    expect(await storage.db.prepare(statusSql()).first()).toEqual(before);
    expect(before).toMatchObject({ total: 5, positive: 3, negative: 1 });
  });
});
