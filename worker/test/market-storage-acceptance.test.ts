import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteD1 } from "./helpers/sqlite-d1";
import { copyStorageArchiveBlock } from "../src/market-storage-copy";
import { buildEodCatalogRow, encodeEodCatalogPayload, EOD_CATALOG_METHODOLOGY_VERSION } from "../src/eod-catalog-service";
import { EOD_PUBLICATION_SCOPES } from "../src/eod-coordinator";
import { EOD_METRICS_VERSION } from "../src/eod-metrics";
import { eodHash } from "../src/eod-publication-service";
import { storagePublicationGrowthReserve, validateStorageCapacityAnalysis, validateStorageConsumerEvidence,
  verifyStorageAcceptedPublications, verifyStorageConsumerBatch, type StorageAcceptanceCapture } from "../src/market-storage-acceptance";
import type { MarketHistoryBar } from "../src/market-history";
import type { Env } from "../src/types";

const identity = { id: "market-storage:test", sourceDatabaseId: "10000000-0000-0000-0000-000000000001",
  targetDatabaseId: "10000000-0000-0000-0000-000000000002", historyDatabaseId: "10000000-0000-0000-0000-000000000003",
  sessionDate: "2026-09-08", codeRevision: "a".repeat(40) };
const capture: StorageAcceptanceCapture = { identity, captureHash: "b".repeat(64),
  sourceCapture: { schemaHash: "c".repeat(64), revision: 0 }, targetCapture: { schemaHash: "c".repeat(64), revision: 0 },
  historyCapture: { schemaHash: "d".repeat(64), revision: 0 } };
const dates: string[] = [];
for (const date = new Date(`${identity.sessionDate}T00:00:00Z`); dates.length < 1_380; date.setUTCDate(date.getUTCDate() - 1)) {
  if (![0, 6].includes(date.getUTCDay())) dates.unshift(date.toISOString().slice(0, 10));
}
function bars(ticker: string, length: number, feed = "sip"): MarketHistoryBar[] {
  return dates.slice(-length).map((date, index) => ({ ticker, date, feed, o: 100 + index, h: 103 + index,
    l: 98 + index, c: 101 + index, volume: index % 11 === 0 ? null : 123_456, reportedVolume: index % 11 === 0 ? null : 120_000,
    reportedVolumeCollectedAt: `${date}T21:00:00Z`, sourceProvider: feed === "sip" ? "alpaca" : "yahoo", adjustment: "split",
    observedAt: `${date}T21:00:00Z`, fetchedAt: `${date}T21:00:00Z` }));
}

describe("executable storage consumer acceptance", () => {
  let source: ReturnType<typeof createSqliteD1>, target: ReturnType<typeof createSqliteD1>, history: ReturnType<typeof createSqliteD1>;
  let sourceEnv: Env, targetEnv: Env;
  beforeEach(() => {
    source = createSqliteD1(); target = createSqliteD1(); history = createSqliteD1();
    source.migrate("market-data-migrations"); target.migrate("market-data-migrations"); history.migrate("history-migrations");
    sourceEnv = { DB: source.db, MARKET_DATA_DB: source.db, EOD_RUNNER_MODE: "shadow" } as Env;
    targetEnv = { DB: target.db, MARKET_DATA_DB: target.db, MARKET_HISTORY_DB: history.db, EOD_RUNNER_MODE: "shadow" } as Env;
  }, 30_000);
  afterEach(() => { source.dispose(); target.dispose(); history.dispose(); });
  async function hot(db: D1Database, rows: MarketHistoryBar[]) {
    await db.prepare(`INSERT INTO alpaca_daily_bars(feed,ticker,date,o,h,l,c,volume,reported_volume,reported_volume_collected_at,
      source_provider,adjustment,observed_at,fetched_at) SELECT json_extract(value,'$.feed'),json_extract(value,'$.ticker'),
      json_extract(value,'$.date'),json_extract(value,'$.o'),json_extract(value,'$.h'),json_extract(value,'$.l'),json_extract(value,'$.c'),
      json_extract(value,'$.volume'),json_extract(value,'$.reportedVolume'),json_extract(value,'$.reportedVolumeCollectedAt'),
      json_extract(value,'$.sourceProvider'),json_extract(value,'$.adjustment'),json_extract(value,'$.observedAt'),json_extract(value,'$.fetchedAt')
      FROM json_each(?)`).bind(JSON.stringify(rows)).run();
  }
  async function archive(rows: MarketHistoryBar[]) {
    const years = new Map<string, MarketHistoryBar[]>();
    for (const row of rows) {
      const key = `${row.feed}:${row.ticker}:${row.date.slice(0, 4)}`;
      const group = years.get(key) ?? []; group.push(row); years.set(key, group);
    }
    for (const rows of years.values()) await copyStorageArchiveBlock(history.db, rows);
  }
  it("resumes complete MAX, 520 OHLCV and 1330 closes with gaps, null volumes, Yahoo and missing members", async () => {
    const long = bars("AAA", 1_380).filter((_, index) => index !== 50), ipo = bars("IPO", 5), yahoo = bars("YAHOO", 20, "yahoo-eod");
    await hot(source.db, [...long, ...ipo, ...yahoo]);
    await archive([...long.slice(0, -1), ...ipo.slice(0, -1), ...yahoo.slice(0, -1)]);
    await hot(target.db, [long.at(-1)!, ipo.at(-1)!, yahoo.at(-1)!]);
    let checks = 0;
    const input = { sourceEnv, targetEnv, capture, tickers: ["AAA", "IPO", "NONE", "YAHOO"], calendarDates: dates,
      assertCapture: async () => { checks++; }, maxTickers: 2 };
    const first = await verifyStorageConsumerBatch(input);
    expect(first.evidence).toBeNull(); expect(first.checkpoint.nextTicker).toBe(2);
    const last = await verifyStorageConsumerBatch({ ...input, checkpoint: first.checkpoint });
    expect(last.evidence).not.toBeNull(); expect(checks).toBe(4);
    expect(last.evidence?.checks["correlation-5y"].observations).toBe(1_335);
    expect(last.evidence?.history).toEqual({ missing: 2, shorterThan520: 3, shorterThan1330: 3 });
    await expect(validateStorageConsumerEvidence(last.evidence!, capture, input.tickers)).resolves.toBeUndefined();
    await expect(validateStorageConsumerEvidence({ ...last.evidence!, nextTicker: 3 }, capture, input.tickers)).rejects.toThrow("consumer-proof-incomplete");
    await expect(verifyStorageConsumerBatch({ ...input, checkpoint: first.checkpoint, tickers: ["AAA", "IPO", "NONE"] })).rejects.toThrow("checkpoint-capture-mismatch");
    await expect(verifyStorageConsumerBatch({ ...input, checkpoint: first.checkpoint,
      capture: { ...capture, historyCapture: { ...capture.historyCapture, revision: 1 } } })).rejects.toThrow("checkpoint-capture-mismatch");
  }, 60_000);
  it("fails on a target correction, missing archive and capture changes rather than certifying available rows", async () => {
    const rows = bars("AAA", 10);
    await hot(source.db, rows); await hot(target.db, rows.slice(-1));
    const input = { sourceEnv, targetEnv, capture, tickers: ["AAA"], calendarDates: dates, assertCapture: async () => {} };
    await expect(verifyStorageConsumerBatch(input)).rejects.toThrow("consumer-mismatch:ticker-max:AAA");
    await archive(rows.slice(0, -1));
    await target.db.prepare("UPDATE alpaca_daily_bars SET c=c+1 WHERE ticker='AAA'").run();
    await expect(verifyStorageConsumerBatch(input)).rejects.toThrow("consumer-mismatch:ticker-max:AAA");
    await target.db.prepare("UPDATE alpaca_daily_bars SET c=c-1 WHERE ticker='AAA'").run();
    let checked = 0;
    await expect(verifyStorageConsumerBatch({ ...input, assertCapture: async () => {
      if (++checked === 2) throw new Error("capture-changed");
    } })).rejects.toThrow("capture-changed");
  }, 30_000);
  it("requires measured finite publication growth and live physical size for full dual-feed retention", async () => {
    history.script("CREATE TABLE IF NOT EXISTS market_storage_fence(id TEXT PRIMARY KEY,revision INTEGER); INSERT INTO market_storage_fence(id,revision) VALUES('default',0) ON CONFLICT(id) DO NOTHING;");
    const tickers = ["AAA"], tickerHash = await eodHash(tickers), now = new Date("2026-09-08T22:00:00Z");
    const growth = { version: 1, measuredAt: now.toISOString(), codeRevision: identity.codeRevision, tickerHash,
      schemaHash: capture.sourceCapture.schemaHash, fixtureSha256: "e".repeat(64), beforeBytes: 4_096, afterBytes: 12_288,
      measurementMethod: "sqlite-real-publication-schema-v1", sourceSnapshotSha256: "f".repeat(64),
      sourcePublicationIds: Array.from({ length: 7 }, (_, index) => `publication:${index}`),
      sourcePublicationChecksums: Array.from({ length: 7 }, () => "a".repeat(64)), sourceSessionDate: identity.sessionDate,
      samplesHash: "c".repeat(64), publicationEvidenceHash: "d".repeat(64),
      completeSessionSets: 2, publicationRows: 14, forecastSessions: 20, revisionsPerSession: 2 };
    const reserve = storagePublicationGrowthReserve(growth, { codeRevision: identity.codeRevision, tickerHash, schemaHash: capture.sourceCapture.schemaHash });
    expect(reserve).toBe(163_840);
    const report = { version: 1, measuredAt: now.toISOString(), sessionDate: identity.sessionDate,
      source: { snapshotSha256: "f".repeat(64), capture: { kind: "logical-d1-capacity-snapshot", completeDeclared: true, partialEstimate: false } },
      population: { count: 1, sha256: tickerHash }, archive: { withAdditionalCompleteRevisionAndTransientBytes: 2_000_000 },
      retentionModels: [260, 90].map((hotSessions) => ({ hotSessions, sweepHeadroomSessions: 10, sharedTickers: 1,
        fallbackTickerReserve: 1, modeledSipRows: hotSessions + 10, modeledFallbackRows: hotSessions + 10,
        database: { physicalBytes: hotSessions === 260 ? 360_000_000 : 2_000_000 }, publicationGrowthReserveBytes: reserve,
        projectedBytes: (hotSessions === 260 ? 360_000_000 : 2_000_000) + reserve })) };
    const input = { analysis: report, publicationGrowth: growth, identity, tickers, sourceSchemaHash: capture.sourceCapture.schemaHash,
      sourceSnapshotSha256: "f".repeat(64), target: target.db, history: history.db, now,
      publications: await (async () => {
        const proof = { version: 1 as const, identity, runId: "run", sessionDate: identity.sessionDate, inputClock: 0,
          tickerHash, tickerCount: 1, checkedAt: now.toISOString(), membershipHash: "a".repeat(64), catalogHash: "b".repeat(64),
          scopes: [...EOD_PUBLICATION_SCOPES, "history:catalog"].map((scope, index) => ({ scope,
            id: `publication:${index}`, revision: 1, checksum: "a".repeat(64) })) };
        return { ...proof, evidenceHash: await eodHash(proof) };
      })() };
    await expect(validateStorageCapacityAnalysis(input)).resolves.toMatchObject({ hotSessions: 90, forecastSessions: 20, publicationGrowthReserveBytes: reserve });
    await expect(validateStorageCapacityAnalysis({ ...input, publicationGrowth: { ...growth, afterBytes: growth.beforeBytes } })).rejects.toThrow("growth-identity-mismatch");
    await expect(validateStorageCapacityAnalysis({ ...input, sourceSnapshotSha256: "0".repeat(64) })).rejects.toThrow("snapshot-incomplete");
    report.retentionModels[1].fallbackTickerReserve = 0;
    await expect(validateStorageCapacityAnalysis(input)).rejects.toThrow("full-population-capacity-headroom-missing");
  }, 30_000);
});

describe("accepted storage publications on the real schema", () => {
  let market: ReturnType<typeof createSqliteD1>, history: ReturnType<typeof createSqliteD1>, ops: ReturnType<typeof createSqliteD1>;
  let env: Env;
  const tickers = ["AAA", "NONE"], runId = "eod:active:2026-09-08:daily";
  beforeEach(async () => {
    market = createSqliteD1(); history = createSqliteD1(); ops = createSqliteD1();
    market.migrate("market-data-migrations"); history.migrate("history-migrations"); ops.migrate("ops-migrations");
    env = { DB: market.db, MARKET_DATA_DB: market.db, MARKET_HISTORY_DB: history.db, OPS_DB: ops.db, EOD_READ_ENABLED: "true" } as Env;
    const memberships = EOD_PUBLICATION_SCOPES.filter((scope) => scope.startsWith("breadth:")).map((scope) => ({ universeId: scope.slice(8), versionId: `membership:${scope}`, members: ["AAA"] }));
    const catalog = encodeEodCatalogPayload(identity.sessionDate, tickers.map((ticker) => buildEodCatalogRow(ticker, [], 0)));
    const rows = [...EOD_PUBLICATION_SCOPES, "history:catalog"];
    for (const scope of rows) {
      const payload = scope === "history:catalog" ? catalog : scope === "overview:default" ? { status: "ready", freshnessCurrentCount: 1,
        asOfDate: identity.sessionDate, sections: [{ id: "macro", groups: [{ id: "indices", rows: tickers.map((ticker) => ({ ticker })) }] }] }
        : { asOfDate: identity.sessionDate, publishable: true, metrics: { memberCount: 1, totalUniverseMembers: 1 }, membership: { versionId: `membership:${scope}` } };
      await market.db.prepare(`INSERT INTO eod_publications(id,scope,session_date,revision,input_hash,methodology_version,payload_json,
        payload_checksum,payload_codec,status,created_at,accepted_at) VALUES(?,?,?,1,?,?,?,?,'json','accepted',?,?)`)
        .bind(`pub:${scope}`, scope, identity.sessionDate, `hash:${scope}`, scope === "history:catalog" ? EOD_CATALOG_METHODOLOGY_VERSION : EOD_METRICS_VERSION,
          JSON.stringify(payload), await eodHash(payload), `${identity.sessionDate}T21:00:00Z`, `${identity.sessionDate}T21:00:00Z`).run();
      await market.db.prepare("INSERT INTO eod_publication_pointers(scope,publication_id,session_date,published_at) VALUES(?,?,?,?)")
        .bind(scope, `pub:${scope}`, identity.sessionDate, `${identity.sessionDate}T21:00:00Z`).run();
    }
    await ops.db.prepare(`INSERT INTO eod_runs(id,session_date,purpose,mode,status,input_json,progress_json,completed_at,completed_input_clock,created_at,updated_at)
      VALUES(?,?,'daily','active','completed',?,?,?,0,?,?)`).bind(runId, identity.sessionDate,
      JSON.stringify({ tickers, memberships, methodologyVersion: EOD_METRICS_VERSION,
        config: { sections: [{ id: "macro", groups: [{ id: "indices", items: tickers.map((ticker) => ({ ticker, enabled: true })) }] }] } }),
      JSON.stringify({ symbols: tickers.length, published: EOD_PUBLICATION_SCOPES.map((scope) => `pub:${scope}`), catalogPublicationId: "pub:history:catalog" }),
      `${identity.sessionDate}T21:01:00Z`, `${identity.sessionDate}T21:00:00Z`, `${identity.sessionDate}T21:01:00Z`).run();
  }, 30_000);
  afterEach(() => { market.dispose(); history.dispose(); ops.dispose(); });
  it("collects all seven accepted references and fails when a current pointer is missing", async () => {
    const input = { env, identity, runId, tickers, expectedSession: identity.sessionDate };
    const evidence = await verifyStorageAcceptedPublications(input);
    expect(evidence.scopes).toHaveLength(7); expect(evidence.tickerCount).toBe(2);
    await market.db.prepare("DELETE FROM eod_publication_pointers WHERE scope='breadth:nasdaq-core'").run();
    await expect(verifyStorageAcceptedPublications(input)).rejects.toThrow("accepted-scope-set-incomplete");
  }, 30_000);
  it("rejects legacy catalog compatibility, stale clocks and reduced population", async () => {
    const input = { env, identity, runId, tickers, expectedSession: identity.sessionDate };
    await expect(verifyStorageAcceptedPublications({ ...input, tickers: ["AAA"] })).rejects.toThrow("population-mismatch");
    await market.db.prepare("UPDATE eod_input_clock SET revision=1 WHERE id='default'").run();
    await expect(verifyStorageAcceptedPublications(input)).rejects.toThrow("inputs-changed");
    await market.db.prepare("UPDATE eod_input_clock SET revision=0 WHERE id='default'").run();
    const payload = encodeEodCatalogPayload(identity.sessionDate, tickers.map((ticker) => buildEodCatalogRow(ticker, [], 0)));
    delete payload.compatibility;
    await market.db.prepare("UPDATE eod_publications SET payload_json=?,payload_checksum=? WHERE id='pub:history:catalog'")
      .bind(JSON.stringify(payload), await eodHash(payload)).run();
    await expect(verifyStorageAcceptedPublications(input)).rejects.toThrow("catalog-complete-compatibility-required");
  }, 30_000);
  it("rejects a checksummed Overview that silently drops a configured ticker", async () => {
    const payload = { status: "ready", freshnessCurrentCount: 1, asOfDate: identity.sessionDate,
      sections: [{ id: "macro", groups: [{ id: "indices", rows: [{ ticker: "AAA" }] }] }] };
    await market.db.prepare("UPDATE eod_publications SET payload_json=?,payload_checksum=? WHERE id='pub:overview:default'")
      .bind(JSON.stringify(payload), await eodHash(payload)).run();
    await expect(verifyStorageAcceptedPublications({ env, identity, runId, tickers, expectedSession: identity.sessionDate }))
      .rejects.toThrow("overview-configured-sections-not-preserved");
  }, 30_000);
});
