import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/types";
import { stageAndPromoteUniverseVersion } from "../src/universe-version-service";
import { createSqliteD1 } from "./helpers/sqlite-d1";

type RecordedStatement = { sql: string; params: unknown[] };

describe("resumable membership staging against migrated SQLite", () => {
  let storage: ReturnType<typeof createSqliteD1>;
  let env: Env;
  let beforeRun: (statement: RecordedStatement) => void;
  let failPromotion: boolean;
  let writes: RecordedStatement[];
  let transactions: RecordedStatement[][];

  beforeEach(() => {
    storage = createSqliteD1();
    storage.migrate("market-data-migrations");
    beforeRun = () => {};
    failPromotion = false;
    writes = [];
    transactions = [];
    const makeStatement = (sql: string, params: unknown[] = []): D1PreparedStatement => {
      const underlying = storage.db.prepare(sql).bind(...params);
      return {
        sql, params,
        bind: (...values: unknown[]) => makeStatement(sql, values),
        first: (column?: string) => column === undefined ? underlying.first() : underlying.first(column),
        all: () => underlying.all(),
        run: async () => {
          beforeRun({ sql, params });
          writes.push({ sql, params });
          return underlying.run();
        },
      } as unknown as D1PreparedStatement;
    };
    const db = {
      prepare: (sql: string) => makeStatement(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        expect(statements.length).toBeLessThanOrEqual(40);
        const recorded = statements as unknown as RecordedStatement[];
        transactions.push(recorded);
        const real = recorded.map(({ sql, params }) => storage.db.prepare(sql).bind(...params));
        // SQLite must roll back earlier delta/pointer statements when the final
        // statement fails, exactly as one D1 REST batch transaction would.
        if (failPromotion) real.push(storage.db.prepare("INSERT INTO missing_test_table VALUES (1)"));
        return storage.db.batch(real);
      },
    } as unknown as D1Database;
    env = { DB: db, MARKET_DATA_DB: db } as Env;
  }, 30_000);
  afterEach(() => storage?.dispose());

  const members = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}${String(index).padStart(5, "0")}`);
  const input = (tickers: string[]) => ({
    universeId: "overall-market-proxy", universeName: "Overall Market", source: "Nasdaq Trader",
    sourceType: "official-exchange-directory", sourceUrl: "https://example.test/directory.txt",
    sourceAsOfDate: "2026-09-08", tickers,
  });
  async function count(table: string, where = "1=1") {
    return (await storage.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).first<{ count: number }>())!.count;
  }
  async function pointer() {
    return (await storage.db.prepare("SELECT active_version_id AS id FROM universes WHERE id='overall-market-proxy'").first<{ id: string | null }>())?.id;
  }

  it("resumes a6000-member stage across UTC dates without another version or rewriting staged rows", async () => {
    const tickers = members("S", 6_000);
    let chunks = 0;
    beforeRun = ({ sql, params }) => {
      if (!sql.includes("eod-universe-stage")) return;
      expect(JSON.parse(String(params[1])).length).toBeLessThanOrEqual(400);
      if (++chunks === 3) throw new Error("eod-d1-budget-exhausted");
    };
    await expect(stageAndPromoteUniverseVersion(env, input(tickers))).rejects.toThrow("budget-exhausted");
    expect(await count("universe_versions")).toBe(1);
    expect(await count("universe_version_members")).toBe(800);
    expect(await count("universe_symbols")).toBe(0);
    expect(await pointer()).toBeNull();
    const staged = await storage.db.prepare("SELECT id, source_as_of_date AS date FROM universe_versions").first<{ id: string; date: string }>();
    beforeRun = () => {};
    writes = [];
    const result = await stageAndPromoteUniverseVersion(env, { ...input(tickers), sourceAsOfDate: "2026-09-09" });
    expect(result.versionId).toBe(staged!.id);
    expect(await count("universe_versions")).toBe(1);
    expect(await count("universe_version_members")).toBe(6_000);
    expect(await count("universe_symbols")).toBe(6_000);
    expect(await pointer()).toBe(staged!.id);
    expect(await storage.db.prepare("SELECT source_as_of_date AS date FROM universe_versions").first()).toEqual({ date: "2026-09-08" });
    expect(writes.filter(({ sql }) => sql.includes("eod-universe-stage"))
      .reduce((sum, { params }) => sum + JSON.parse(String(params[1])).length, 0)).toBe(5_200);
    expect(transactions).toHaveLength(1);
  }, 30_000);

  it("rolls back compatibility rows and pointer together, then resumes a one-member delta", async () => {
    const original = members("S", 4_000);
    const first = await stageAndPromoteUniverseVersion(env, input(original));
    const revised = [...original.slice(1), "NEW"];
    failPromotion = true;
    await expect(stageAndPromoteUniverseVersion(env, input(revised))).rejects.toThrow();
    expect(await pointer()).toBe(first.versionId);
    expect(await count("universe_symbols", "ticker='S00000'")).toBe(1);
    expect(await count("universe_symbols", "ticker='NEW'")).toBe(0);
    expect(await count("universe_versions")).toBe(2);
    failPromotion = false;
    writes = [];
    const result = await stageAndPromoteUniverseVersion(env, input(revised));
    expect(result.versionId).not.toBe(first.versionId);
    expect(await pointer()).toBe(result.versionId);
    expect(await count("universe_symbols")).toBe(4_000);
    expect(await count("universe_symbols", "ticker='NEW'")).toBe(1);
    expect(writes.some(({ sql }) => sql.includes("eod-universe-stage"))).toBe(false);
    const last = transactions.at(-1)!;
    expect(JSON.parse(String(last.find(({ sql }) => sql.includes("promote-delete"))!.params[1]))).toEqual(["S00000"]);
    expect(JSON.parse(String(last.find(({ sql }) => sql.includes("promote-insert"))!.params[1]))).toEqual(["NEW"]);
    expect(await count("universe_versions", "status='active'")).toBe(1);
  }, 30_000);

  it("creates immutable improved-source versions, skips fresh verification writes, and keeps membership recurrences distinct", async () => {
    const base = { ...input(["A", "B", "C"]), universeId: "test-universe", source: "Bundled", sourceType: "bundled-fallback" };
    const old = await stageAndPromoteUniverseVersion(env, base);
    const primary = { ...base, source: "Official", sourceType: "official-directory" };
    const improved = await stageAndPromoteUniverseVersion(env, primary);
    expect(improved.versionId).not.toBe(old.versionId);
    expect(await storage.db.prepare("SELECT source, status FROM universe_versions WHERE id=?").bind(old.versionId).first())
      .toEqual({ source: "Bundled", status: "superseded" });
    writes = [];
    expect(await stageAndPromoteUniverseVersion(env, { ...primary, sourceAsOfDate: "2026-09-09" }))
      .toMatchObject({ versionId: improved.versionId, unchanged: true });
    expect(writes).toEqual([]);
    await stageAndPromoteUniverseVersion(env, { ...primary, tickers: ["B", "C", "D"] });
    const recurrence = await stageAndPromoteUniverseVersion(env, primary);
    expect(recurrence.versionId).not.toBe(improved.versionId);
    expect(await count("universe_versions")).toBe(4);
  }, 30_000);
});
