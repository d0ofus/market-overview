import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { refreshHistoryMaintenanceEvidence, type HistoryMaintenanceProof } from "../src/eod-history-capacity";
import { MARKET_HISTORY_REQUIRED_CONSUMERS } from "../src/eod-history-maintenance";
import type { Env } from "../src/types";
import { createSqliteD1 } from "./helpers/sqlite-d1";

describe("automatic history capacity evidence against real SQLite", { timeout: 25_000 }, () => {
  let market: ReturnType<typeof createSqliteD1>;
  let archive: ReturnType<typeof createSqliteD1>;
  let ops: ReturnType<typeof createSqliteD1>;
  let env: Env;
  const revision = "a".repeat(40);
  const now = new Date("2026-09-09T00:00:00Z");
  let sampleQueries: string[];
  let failSampleAt: number | null;
  let physicalOverride: number | "absent" | null;

  beforeEach(() => {
    market = createSqliteD1(); archive = createSqliteD1(); ops = createSqliteD1();
    market.migrate("market-data-migrations"); archive.migrate("history-migrations"); ops.migrate("ops-migrations");
    sampleQueries = []; failSampleAt = null; physicalOverride = null;
    const wrapped = { ...market.db, prepare(sql: string) {
      const build = (statement: D1PreparedStatement): D1PreparedStatement => ({
        bind: (...params: unknown[]) => build(statement.bind(...params)),
        async all<T = Record<string, unknown>>() {
          if (sql.includes("as retainedRows")) {
            sampleQueries.push(sql);
            if (sampleQueries.length === failSampleAt) throw new Error("eod-d1-budget-exhausted");
          }
          const result = await statement.all<T>();
          if (sql.includes("history_capacity_probe") && physicalOverride !== null) {
            if (physicalOverride === "absent") Reflect.deleteProperty(result.meta, "size_after");
            else result.meta.size_after = physicalOverride;
          }
          return result;
        },
        first: statement.first.bind(statement), run: statement.run.bind(statement), raw: statement.raw?.bind(statement),
      } as D1PreparedStatement);
      return build(market.db.prepare(sql));
    } } as D1Database;
    env = { DB: market.db, MARKET_DATA_DB: wrapped, MARKET_HISTORY_DB: archive.db, OPS_DB: ops.db,
      EOD_RUNNER_MODE: "shadow", EOD_CODE_REVISION: revision, EOD_ARCHIVE_PRUNE_ENABLED: "true" } as Env;
  }, 30_000);
  afterEach(() => { market.dispose(); archive.dispose(); ops.dispose(); });

  async function seed(tickers: string[]): Promise<HistoryMaintenanceProof> {
    await market.db.batch(tickers.map((ticker) => market.db.prepare(`INSERT INTO alpaca_daily_bars
      (feed,ticker,date,o,h,l,c,volume,source_provider,adjustment,fetched_at) VALUES('sip',?,'2026-09-08',10,11,9,10.5,100,'alpaca','split','2026-09-08T23:00:00Z')`).bind(ticker)));
    const marketBytes = (await market.db.prepare("SELECT 1").all()).meta.size_after!;
    const archiveBytes = (await archive.db.prepare("SELECT 1").all()).meta.size_after!;
    // Independent initial page accounting is represented by this test fixture;
    // live size_after values above come from the real temporary SQLite files.
    const priceBytes = Math.ceil(tickers.length * 180 / 4096) * 4096;
    const proof: HistoryMaintenanceProof = {
      version: 1, codeRevision: revision, population: { tickers, feed: "sip" }, hotSessions: 260, sweepHeadroomSessions: 10,
      capacity: { measuredAt: now.toISOString(), marketDatabaseBytes: marketBytes, priceTableAndIndexBytes: priceBytes,
        priceRows: tickers.length, retainedPriceRows: tickers.length * 270, archiveDatabaseBytes: archiveBytes, additionalArchiveBytes: 50_000 },
      readers: { contractVersion: 1, checkedAt: now.toISOString(), consumers: [...MARKET_HISTORY_REQUIRED_CONSUMERS], parityPassed: true },
    };
    await ops.db.prepare("INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES('history-capacity',?,?)")
      .bind(JSON.stringify(proof), now.toISOString()).run();
    return proof;
  }

  it("keeps original parity approval across UTC days and weeks while re-reading physical storage", async () => {
    const proof = await seed(["AAA"]);
    const first = await refreshHistoryMaintenanceEvidence(env, { tickers: ["AAA"], codeRevision: revision, now });
    expect(first.sample.sampledRows).toBe(1);
    expect(sampleQueries).toHaveLength(1);
    const later = new Date("2026-09-19T00:00:00Z");
    physicalOverride = 1_000_000;
    const second = await refreshHistoryMaintenanceEvidence(env, { tickers: ["AAA"], codeRevision: revision, now: later });
    expect(sampleQueries).toHaveLength(1);
    expect(second.readers).toEqual({ ...proof.readers, codeRevision: revision });
    expect(second.capacity.measuredAt).toBe(later.toISOString());
    expect(second.sample.marketPhysicalBytes).toBe(1_000_000);
    expect(second.capacity.liveProjection!.marketBytes).toBeGreaterThan(1_000_000);
    const original = await ops.db.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id='history-capacity'").first<{ evidence_json: string }>();
    expect(JSON.parse(original!.evidence_json).capacity.measuredAt).toBe(proof.capacity.measuredAt);
  });

  it("resumes only unfinished bounded chunks after quota exhaustion without restarting the approval", async () => {
    const tickers = Array.from({ length: 81 }, (_, index) => `A${String(index).padStart(3, "0")}`);
    await seed(tickers);
    failSampleAt = 2;
    await expect(refreshHistoryMaintenanceEvidence(env, { tickers, codeRevision: revision, now })).rejects.toThrow(/budget-exhausted/);
    const saved = await ops.db.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?").bind(`history-sample:${revision}`).first<{ evidence_json: string }>();
    expect(JSON.parse(saved!.evidence_json).rows).toHaveLength(80);
    failSampleAt = null;
    const result = await refreshHistoryMaintenanceEvidence(env, { tickers, codeRevision: revision, now: new Date("2026-09-10T00:05:00Z") });
    expect(result.sample.sampledSymbols).toBe(81);
    expect(sampleQueries).toHaveLength(3);
    expect(sampleQueries.every((sql) => sql.includes("LIMIT ?") && sql.includes("b.ticker=requested.value"))).toBe(true);
  });

  it("resamples changed securities instead of reusing a stale hot-row count", async () => {
    await seed(["AAA", "BBB"]);
    await refreshHistoryMaintenanceEvidence(env, { tickers: ["AAA", "BBB"], codeRevision: revision, now });
    await market.db.prepare("DELETE FROM alpaca_daily_bars WHERE ticker='AAA'").run();
    const result = await refreshHistoryMaintenanceEvidence(env, { tickers: ["AAA", "BBB"], codeRevision: revision, now });
    expect(result.sample.sampledRows).toBe(1);
    expect(result.capacity.liveProjection!.remainingHotRows).toBe(539);
    expect(sampleQueries).toHaveLength(2);
  });

  it("fails closed on absent metadata and on an oversized physical file without inventing reclaimed space", async () => {
    await seed(["AAA"]);
    physicalOverride = "absent";
    await expect(refreshHistoryMaintenanceEvidence(env, { tickers: ["AAA"], codeRevision: revision, now })).rejects.toThrow(/physical-size-metadata-unavailable/);
    physicalOverride = 371_000_000;
    await expect(refreshHistoryMaintenanceEvidence(env, { tickers: ["AAA"], codeRevision: revision, now })).rejects.toThrow(/350 MB/);
    expect(sampleQueries).toHaveLength(1);
    const measurement = await ops.db.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?").bind(`history-measurement:${revision}`).first<{ evidence_json: string }>();
    expect(JSON.parse(measurement!.evidence_json)).toMatchObject({ status: "failed", error: expect.stringMatching(/350 MB/) });
  });

  it("requires complete population and new independent proof for another code revision", async () => {
    await seed(["AAA", "BBB"]);
    await expect(refreshHistoryMaintenanceEvidence(env, { tickers: ["AAA"], codeRevision: revision, now })).rejects.toThrow(/initial-population-mismatch/);
    const nextRevision = "b".repeat(40);
    await expect(refreshHistoryMaintenanceEvidence({ ...env, EOD_CODE_REVISION: nextRevision },
      { tickers: ["AAA", "BBB"], codeRevision: nextRevision, now })).rejects.toThrow(/initial-proof-required/);
    expect(sampleQueries).toHaveLength(0);
  });
});
