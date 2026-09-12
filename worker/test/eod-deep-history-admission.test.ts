import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteD1 } from "./helpers/sqlite-d1";
import { admitEodDeepHistory, eodDeepHistoryWeek, loadEodDeepHistoryBudget, storeEodDeepHistoryPolicy } from "../src/eod-deep-history-admission";
import { estimateEodQueries } from "../src/eod-d1-rest";
const now = new Date("2026-09-13T23:59:59.000Z");
const dates = (count: number) => Array.from({ length: count }, (_, index) => new Date(Date.parse("2026-09-11T00:00:00Z") - (count - index - 1) * 86_400_000).toISOString().slice(0, 10));
describe("durable weekly deep-history capacity", { timeout: 40_000 }, () => {
  let ops: ReturnType<typeof createSqliteD1>;
  beforeEach(() => { ops = createSqliteD1(); ops.migrate("ops-migrations"); });
  afterEach(() => ops.dispose());
  it("charges deeper requests only for new dates and does not refund a repeated claim", async () => {
    expect((await admitEodDeepHistory(ops.db, { ticker: "SPY", dates: dates(520) }, now)).budget.observations).toBe(520);
    const expanded = await admitEodDeepHistory(ops.db, { ticker: "SPY", dates: dates(1400) }, now);
    expect(expanded.budget.observations).toBe(1400); expect(expanded.budget.claims).toHaveLength(1);
    expect(await admitEodDeepHistory(ops.db, { ticker: "SPY", dates: dates(1400) }, now)).toEqual(expanded);
    const refused = await admitEodDeepHistory(ops.db, { ticker: "QQQ", dates: dates(1400) }, now);
    expect(refused.admitted).toBe(false); expect(refused.budget).toEqual(expanded.budget);
    expect(await admitEodDeepHistory(ops.db, { ticker: "SPY", dates: dates(2501) }, now))
      .toMatchObject({admitted:false,reason:"history-request-exceeds-weekly-capacity"});
    expect((await loadEodDeepHistoryBudget(ops.db, now)).observations).toBe(1400);
  });
  it("atomically admits only one competing 1500-observation request", async () => {
    const results = await Promise.all(["AAA", "BBB"].map(ticker => admitEodDeepHistory(ops.db, { ticker, dates: dates(1500) }, now)));
    expect(results.filter(row => row.admitted)).toHaveLength(1);
    const state = await loadEodDeepHistoryBudget(ops.db, now);
    expect(state.observations).toBe(1500); expect(state.claims).toHaveLength(1);
  });
  it("recovers a lost mutation response without charging the same request twice", async () => {
    let lose = true;
    const wrapped = { prepare(sql: string) {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => ({
        bind: (...params: unknown[]) => wrap(statement.bind(...params)), first: statement.first.bind(statement),
        all: async () => { const result = await statement.all(); if (lose && sql.startsWith("INSERT INTO eod_rollout_evidence")) { lose = false; throw new Error("lost-ack"); } return result; },
      } as D1PreparedStatement);
      return wrap(ops.db.prepare(sql));
    } } as D1Database;
    await expect(admitEodDeepHistory(wrapped, { ticker: "SPY", dates: dates(1400) }, now)).rejects.toThrow("lost-ack");
    expect((await admitEodDeepHistory(ops.db, { ticker: "SPY", dates: dates(1400) }, now)).budget.observations).toBe(1400);
  });
  it("enforces the distinct-security cap independently of observation count", async () => {
    for (let index = 0; index < 4; index++) expect((await admitEodDeepHistory(ops.db, { ticker: `S${index}`, dates: dates(1) }, now)).admitted).toBe(true);
    const denied = await admitEodDeepHistory(ops.db, { ticker: "EXTRA", dates: dates(1) }, now);
    expect(denied.admitted).toBe(false); expect(denied.budget.observations).toBe(4);
  });
  it("rolls at UTC Monday, preserves old claims, and carries the fair traversal cursor", async () => {
    const old = await admitEodDeepHistory(ops.db, { ticker: "MIDDLE", dates: dates(1400) }, now);
    await storeEodDeepHistoryPolicy(ops.db, { effectiveWeek: "2026-09-14", maxSecurities: 2, maxObservations: 1000 }, now);
    const monday = new Date("2026-09-14T00:00:00.000Z"), next = await loadEodDeepHistoryBudget(ops.db, monday);
    expect(eodDeepHistoryWeek(now)).toEqual({ weekStart: "2026-09-07", nextAttemptAt: monday.toISOString() });
    expect(next).toMatchObject({ observations: 0, startAfter: "MIDDLE", maxSecurities: 2, maxObservations: 1000 });
    expect((await admitEodDeepHistory(ops.db, { ticker: "MIDDLE", dates: dates(1400) }, monday)).admitted).toBe(false);
    expect((await admitEodDeepHistory(ops.db, { ticker: "NEXT", dates: dates(520) }, monday)).admitted).toBe(true);
    expect(await loadEodDeepHistoryBudget(ops.db, now)).toEqual(old.budget);
  });
  it("only accepts immutable future policies within both reviewed maxima", async () => {
    const policy = { effectiveWeek: "2026-09-14", maxSecurities: 2, maxObservations: 2500 };
    const stored = await storeEodDeepHistoryPolicy(ops.db, policy, now);
    expect(await storeEodDeepHistoryPolicy(ops.db, policy, now)).toEqual(stored);
    await expect(storeEodDeepHistoryPolicy(ops.db, { ...policy, maxObservations: 2000 }, now)).rejects.toThrow("policy-conflict");
    await expect(storeEodDeepHistoryPolicy(ops.db, { ...policy, effectiveWeek: "2026-09-07" }, now)).rejects.toThrow("future-policy-required");
    await expect(storeEodDeepHistoryPolicy(ops.db, { ...policy, maxObservations: 2501 }, now)).rejects.toThrow("future-policy-required");
    await expect(storeEodDeepHistoryPolicy(ops.db, { ...policy, maxSecurities: 5 }, now)).rejects.toThrow("future-policy-required");
  });
  it("fails closed on corrupted counters and uses bounded indexed Ops statements", async () => {
    const query = "UPDATE eod_rollout_evidence SET evidence_json=?,updated_at=? WHERE id=? AND evidence_json=? RETURNING id";
    const explain = await ops.db.prepare(`EXPLAIN QUERY PLAN ${query}`).bind("{}", now.toISOString(), "week", "{}").all<{ detail: string }>();
    expect(explain.results.some(row => /PRIMARY KEY|INDEX/.test(row.detail))).toBe(true);
    expect(explain.results.some(row => /SCAN eod_rollout_evidence/.test(row.detail))).toBe(false);
    expect(estimateEodQueries([{ sql: query, params: ["{}", now.toISOString(), "week", "{}"] }]).writes).toBeGreaterThanOrEqual(1);
    const value = await admitEodDeepHistory(ops.db, { ticker: "SPY", dates: dates(520) }, now);
    await ops.db.prepare("UPDATE eod_rollout_evidence SET evidence_json=? WHERE id=?")
      .bind(JSON.stringify({ ...value.budget, observations: 0 }), "eod-deep-history-week:2026-09-07").run();
    await expect(admitEodDeepHistory(ops.db, { ticker: "QQQ", dates: dates(520) }, now)).rejects.toThrow("record-integrity");
  });
});
