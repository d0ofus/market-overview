import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import ts from "typescript";
import { createSqliteD1 } from "./helpers/sqlite-d1";
import { estimateEodQueries } from "../src/eod-d1-rest";
import { storageHash } from "../src/market-storage-pages";

/** Exercise the actual operator SQL, so removing the feed-prefix constraint
 * cannot leave a passing test around a separate hand-written query. */
function repairQuery(): string {
  const source = ts.createSourceFile("repair.ts", readFileSync(new URL("../src/market-storage-repair-execution.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const values: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) && node.text.startsWith("SELECT * FROM eod_adjustment_repairs")) values.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(values).toHaveLength(1);
  return values[0]!;
}

describe("bounded repair execution evidence query", () => {
  let storage: ReturnType<typeof createSqliteD1> | undefined;
  afterEach(() => storage?.dispose());
  it("uses both primary-key parts, preserving every SIP/Yahoo repair in the failed25-symbol chunk", async () => {
    storage = createSqliteD1(); storage.migrate("market-data-migrations");
    storage.script(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<6329)
      INSERT INTO eod_adjustment_repairs(feed,ticker,status,start_date,updated_at,owner_token)
      SELECT f.feed,printf('S%04d',i),'complete','2025-04-14','2026-09-11T22:39:44.000Z',NULL
      FROM n CROSS JOIN (SELECT 'sip' AS feed UNION ALL SELECT 'yahoo-eod') f;
      UPDATE eod_adjustment_repairs SET ticker='BNRG',status='pending',owner_token='preserved-owner' WHERE ticker='S0000';
      INSERT INTO eod_adjustment_repairs(feed,ticker,status,start_date,updated_at,owner_token)
      VALUES('legacy-other','BNRG','pending','2025-04-14','2026-09-11T22:39:44.000Z','unrelated-owner');`);
    const chunk = ["BNRG", ...Array.from({length:24}, (_, index) => `S${String(index+1).padStart(4,"0")}`)];
    const params = [JSON.stringify(chunk)], sql = repairQuery();
    const oldSql = "SELECT * FROM eod_adjustment_repairs WHERE ticker IN (SELECT value FROM json_each(?)) ORDER BY feed,ticker";
    const before = (await storage.db.prepare(oldSql).bind(...params).all<Record<string, unknown>>()).results;
    const actual = (await storage.db.prepare(sql).bind(...params).all<Record<string, unknown>>()).results;
    const expected = before.filter(row => row.feed === "sip" || row.feed === "yahoo-eod");
    expect(actual).toHaveLength(50);
    expect(actual).toEqual(expected);
    expect(await storageHash(actual)).toBe(await storageHash(expected));
    expect(actual.filter(row => row.ticker === "BNRG")).toEqual([
      {feed:"sip",ticker:"BNRG",status:"pending",start_date:"2025-04-14",updated_at:"2026-09-11T22:39:44.000Z",owner_token:"preserved-owner"},
      {feed:"yahoo-eod",ticker:"BNRG",status:"pending",start_date:"2025-04-14",updated_at:"2026-09-11T22:39:44.000Z",owner_token:"preserved-owner"},
    ]);
    const plan = (await storage.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...params).all<{detail:string}>()).results.map(row => row.detail).join("\n");
    const oldPlan = (await storage.db.prepare(`EXPLAIN QUERY PLAN ${oldSql}`).bind(...params).all<{detail:string}>()).results.map(row => row.detail).join("\n");
    expect(oldPlan).toMatch(/SCAN eod_adjustment_repairs/);
    expect(plan).toMatch(/SEARCH eod_adjustment_repairs USING PRIMARY KEY \(feed=\? AND ticker=\?\)/);
    expect(plan).not.toMatch(/SCAN eod_adjustment_repairs/);
    expect(estimateEodQueries([{sql,params}])).toEqual({reads:2000,writes:0});
    expect((await storage.db.prepare(oldSql).bind(...params).all()).results).toEqual(before);
    expect(await storage.db.prepare("SELECT COUNT(*) AS count FROM eod_adjustment_repairs").first()).toEqual({count:12_661});
  }, 30_000);
});
