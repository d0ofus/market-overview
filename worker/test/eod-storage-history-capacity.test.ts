import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteD1 } from "./helpers/sqlite-d1";
import { refreshHistoryMaintenanceEvidence } from "../src/eod-history-capacity";
import { loadStorageHistoryCapacityStatus, refreshApprovedStorageHistoryCapacity, storeStorageHistoryMaintenanceApproval } from "../src/eod-storage-history-capacity";
import { eodHash } from "../src/eod-publication-service";
import { STORAGE_CONSUMER_CONTRACTS, type StorageAcceptanceCapture, type StorageConsumerEvidence } from "../src/market-storage-acceptance";
import { EOD_PUBLICATION_SCOPES } from "../src/eod-coordinator";
import type { Env } from "../src/types";

describe("archive-first measured layout maintenance", { timeout: 30_000 }, () => {
  let market: ReturnType<typeof createSqliteD1>, history: ReturnType<typeof createSqliteD1>, ops: ReturnType<typeof createSqliteD1>, env: Env;
  const now = new Date("2026-09-09T00:00:00Z"), revision = "a".repeat(40), tickers = ["AAA"];
  const identity = { id: "market-storage:capacity-test", codeRevision: revision, sessionDate: "2026-09-08",
    sourceDatabaseId: "10000000-0000-0000-0000-000000000001", targetDatabaseId: "10000000-0000-0000-0000-000000000002",
    historyDatabaseId: "10000000-0000-0000-0000-000000000003" };
  const capture: StorageAcceptanceCapture = { identity, captureHash: "b".repeat(64),
    sourceCapture: { schemaHash: "c".repeat(64), revision: 0 }, targetCapture: { schemaHash: "c".repeat(64), revision: 0 },
    historyCapture: { schemaHash: "d".repeat(64), revision: 0 } };
  let samples: Array<{ sql: string; params: unknown[] }>, failSample: number | null;
  beforeEach(async () => {
    market = createSqliteD1(); history = createSqliteD1(); ops = createSqliteD1();
    market.migrate("market-data-migrations"); history.migrate("history-migrations"); ops.migrate("ops-migrations");
    samples = []; failSample = null;
    const wrapped = { ...market.db, prepare(sql: string) {
      const build = (statement: D1PreparedStatement, params: unknown[] = []): D1PreparedStatement => ({
        bind: (...next: unknown[]) => build(statement.bind(...next), next),
        async all<T>() {
          if (sql.startsWith("/* eod-capacity-row-sample */")) {
            samples.push({ sql, params }); if (samples.length === failSample) throw new Error("eod-d1-budget-exhausted");
          }
          return statement.all<T>();
        }, first: statement.first.bind(statement), run: statement.run.bind(statement), raw: statement.raw?.bind(statement),
      } as D1PreparedStatement);
      return build(market.db.prepare(sql));
    } } as D1Database;
    env = { DB: market.db, MARKET_DATA_DB: wrapped, MARKET_HISTORY_DB: history.db, OPS_DB: ops.db,
      EOD_RUNNER_MODE: "shadow", EOD_CODE_REVISION: revision, EOD_ARCHIVE_PRUNE_ENABLED: "true" } as Env;
    const future = Array.from({ length: 40 }, (_, index) => new Date(Date.parse("2026-09-09T00:00:00Z") + index * 86_400_000).toISOString().slice(0, 10));
    await market.db.prepare("INSERT INTO market_calendar_sessions(session_date,open_at,close_at,source) SELECT value,'09:30','16:00','fixture' FROM json_each(?)")
      .bind(JSON.stringify(future)).run();
  }, 30_000);
  afterEach(() => { market.dispose(); history.dispose(); ops.dispose(); });
  async function seed(feed: string, total: number) {
    const dates = Array.from({ length: total }, (_, index) => new Date(Date.parse(`${identity.sessionDate}T00:00:00Z`) - index * 86_400_000).toISOString().slice(0, 10));
    await market.db.prepare(`INSERT INTO alpaca_daily_bars(feed,ticker,date,o,h,l,c,volume,source_provider,adjustment,fetched_at)
      SELECT ?,'AAA',value,100,101,99,100,100,?,'split',value||'T21:00:00Z' FROM json_each(?)`)
      .bind(feed, feed === "sip" ? "alpaca" : "yahoo", JSON.stringify(dates)).run();
  }
  async function approve(hot: 260 | 90 = 260) {
    const tickerHash = await eodHash(tickers), priceRows = (hot + 10) * 2;
    const analysis = { measuredAt: now.toISOString(), source: { snapshotSha256: "e".repeat(64) },
      retentionModels: [{ hotSessions: hot, sharedTickers: 1, fallbackTickerReserve: 1, sweepHeadroomSessions: 10,
        modeledSipRows: hot + 10, modeledFallbackRows: hot + 10, projectedBytes: 1_500_000,
        database: { physicalBytes: 1_000_000, priceTableAndIndexBytes: priceRows * 200 } }] };
    const unsigned = { version: 1 as const, inputHash: "f".repeat(64), tickerHash, tickerCount: 1, nextTicker: 1, outputHash: "f".repeat(64),
      checks: Object.fromEntries(STORAGE_CONSUMER_CONTRACTS.map((name) => [name, { tickers: 1, observations: 1, hash: "f".repeat(64) }])) as StorageConsumerEvidence["checks"],
      history: { missing: 0, shorterThan520: 1, shorterThan1330: 1 }, completedAt: now.toISOString(), captureHash: capture.captureHash,
      identity, readerContractVersion: 1 };
    const consumers = { ...unsigned, evidenceHash: await eodHash(unsigned) };
    const pub = { version: 1 as const, identity, runId: "private", sessionDate: identity.sessionDate, inputClock: 0, tickerHash, tickerCount: 1,
      checkedAt: now.toISOString(), scopes: [...EOD_PUBLICATION_SCOPES, "history:catalog"].map((scope) => ({ scope, id: scope, revision: 1, checksum: "f".repeat(64) })),
      membershipHash: "f".repeat(64), catalogHash: "f".repeat(64) };
    return storeStorageHistoryMaintenanceApproval(env, { analysis, consumers, capture, tickers, now,
      publications: { ...pub, evidenceHash: await eodHash(pub) }, capacity: { hotSessions: hot, projectedMarketBytes: 1_500_000,
        projectedHistoryBytes: 2_000_000, liveTargetBytes: 300_000, liveHistoryBytes: 1_000_000, publicationGrowthReserveBytes: 500_000,
        forecastSessions: 20, revisionsPerSession: 2, analysisHash: await eodHash(analysis), measuredAt: now.toISOString() } });
  }
  it("uses the real dual-feed table/index layout for 261 stored SIP rows with 260 retention", async () => {
    await seed("sip", 261); await seed("yahoo-eod", 1); await approve();
    const result = await refreshHistoryMaintenanceEvidence(env, { tickers, codeRevision: revision, now });
    expect(result.feeds).toEqual(["sip", "yahoo-eod"]);
    expect(result.sample.sampledRows).toBe(262);
    expect(result.capacity.liveProjection).toMatchObject({ remainingHotRows: 278, priceBytesPerRowBound: 200 });
    expect(samples).toHaveLength(2);
    expect(samples.every((row) => !row.sql.includes("json_object") && row.params[1] === 271)).toBe(true);
    expect(await loadStorageHistoryCapacityStatus(env, now)).toMatchObject({ status: "ready", hotSessions: 260,
      forecastSessions: 20, forecastAnchorSession: "2026-09-08", forecastLastSession: "2026-09-28" });
  });
  it("accounts for accumulated fallback rows and fails visibly beyond the 90+10 sweep allowance", async () => {
    await seed("sip", 91); await seed("yahoo-eod", 100); await approve(90);
    const first = await refreshHistoryMaintenanceEvidence(env, { tickers, codeRevision: revision, now });
    expect(first.capacity.liveProjection).toMatchObject({ remainingHotRows: 9, sampledRows: 191, priceBytesPerRowBound: 200 });
    await market.db.prepare("INSERT INTO alpaca_daily_bars(feed,ticker,date,o,h,l,c,source_provider,adjustment) VALUES('yahoo-eod','AAA','2026-09-09',100,100,100,100,'yahoo','split')").run();
    await expect(refreshHistoryMaintenanceEvidence(env, { tickers, codeRevision: revision, now })).rejects.toThrow("yahoo-eod-retention-sweep-overflow");
    expect(await loadStorageHistoryCapacityStatus(env, now)).toMatchObject({ status: "failed", error: expect.stringContaining("yahoo-eod") });
  });
  it("does not extend a finite forecast by redating physical checks or silently add a new ticker", async () => {
    await seed("sip", 1); const approved = await approve(90);
    await expect(refreshHistoryMaintenanceEvidence(env, { tickers: ["AAA", "NEW"], codeRevision: revision, now })).rejects.toThrow("population-changed");
    expect(samples).toHaveLength(0);
    const expired = new Date(approved.proof.horizon.expiresAt);
    await expect(refreshHistoryMaintenanceEvidence(env, { tickers, codeRevision: revision, now: expired })).rejects.toThrow("forecast-horizon-expired");
    expect(await loadStorageHistoryCapacityStatus(env, expired)).toMatchObject({ status: "expired", horizonExpiresAt: approved.proof.horizon.expiresAt });
  });
  it("resumes the unfinished provider sample after quota failure and preserves the accepted model", async () => {
    await seed("sip", 1); await seed("yahoo-eod", 2); const approved = await approve(90);
    failSample = 2;
    await expect(refreshHistoryMaintenanceEvidence(env, { tickers, codeRevision: revision, now })).rejects.toThrow("budget-exhausted");
    failSample = null;
    const result = await refreshHistoryMaintenanceEvidence(env, { tickers, codeRevision: revision, now: new Date("2026-09-10T00:00:00Z") });
    expect(result.sample).toMatchObject({ sampledRows: 3, proofHash: approved.proofHash });
    expect(samples.map((row) => row.params[0])).toEqual(["sip", "yahoo-eod", "yahoo-eod"]);
  });
  it("runs monitoring independently of pruning and checks the actual latest catalog population", async () => {
    await expect(refreshApprovedStorageHistoryCapacity(env, now)).resolves.toBeNull();
    await seed("sip", 1); await approve(90);
    await market.db.prepare(`INSERT INTO eod_publications(id,scope,session_date,revision,input_hash,methodology_version,payload_json,status,created_at)
      VALUES('catalog','history:catalog','2026-09-08',1,'hash','sip-history-catalog-v1',?,'accepted',?)`)
      .bind(JSON.stringify({ rows: [["AAA"]] }), now.toISOString()).run();
    await market.db.prepare("INSERT INTO eod_publication_pointers(scope,publication_id,session_date,published_at) VALUES('history:catalog','catalog','2026-09-08',?)")
      .bind(now.toISOString()).run();
    expect(await refreshApprovedStorageHistoryCapacity({ ...env, EOD_ARCHIVE_PRUNE_ENABLED: "false" }, now))
      .toMatchObject({ hotSessions: 90, feeds: ["sip", "yahoo-eod"] });
    expect(await loadStorageHistoryCapacityStatus(env, new Date("2026-09-10T00:01:00Z")))
      .toMatchObject({ status: "unmeasured", error: "live-capacity-measurement-stale" });
    await market.db.prepare("UPDATE eod_publications SET payload_json=? WHERE id='catalog'").bind(JSON.stringify({ rows: [["AAA"], ["NEW"]] })).run();
    await expect(refreshApprovedStorageHistoryCapacity(env, now)).rejects.toThrow("population-changed-remeasurement-required");
  });
});
