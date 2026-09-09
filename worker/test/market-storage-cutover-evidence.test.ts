import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildEodCatalogRow, encodeEodCatalogPayload, EOD_CATALOG_METHODOLOGY_VERSION } from "../src/eod-catalog-service";
import { EOD_PUBLICATION_SCOPES } from "../src/eod-coordinator";
import { EOD_METRICS_VERSION } from "../src/eod-metrics";
import { eodHash } from "../src/eod-publication-service";
import { buildRuntimeEvidence, type RuntimeEvidenceIdentity } from "../src/eod-runtime-evidence";
import { EOD_RUNTIME_COORDINATOR_PATH, type RuntimeProbeSummary } from "../src/eod-runtime-telemetry";
import { verifyStorageAcceptedPublications, verifyStorageConsumerBatch, type StorageAcceptanceCapture } from "../src/market-storage-acceptance";
import { buildStorageCutoverEvidence, collectStorageCutoverUsage, storeStorageCutoverProof } from "../src/market-storage-cutover-evidence";
import type { Env } from "../src/types";
import { createSqliteD1 } from "./helpers/sqlite-d1";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { id: "market-storage:test", sourceDatabaseId: uuid(1), targetDatabaseId: uuid(2), historyDatabaseId: uuid(3),
  sessionDate: "2026-09-08", codeRevision: "a".repeat(40) };
const capture: StorageAcceptanceCapture = { identity, captureHash: "b".repeat(64),
  sourceCapture: { schemaHash: "c".repeat(64), revision: 0 }, targetCapture: { schemaHash: "c".repeat(64), revision: 0 },
  historyCapture: { schemaHash: "d".repeat(64), revision: 0 } };
const runtimeIdentity: RuntimeEvidenceIdentity = { probeId: "private-probe", workerName: "candidate", workerVersion: uuid(6),
  codeRevision: identity.codeRevision, targetDatabaseId: uuid(2), historyDatabaseId: uuid(3), opsDatabaseId: uuid(4), coreDatabaseId: uuid(5) };
async function runtimeFixture() {
  const now = Date.now(), stamp = new Date(now - 20_000).toISOString();
  const bindings = { DB: uuid(5), MARKET_DATA_DB: uuid(2), MARKET_HISTORY_DB: uuid(3), OPS_DB: uuid(4),
    EOD_READ_ENABLED: "true", EOD_RUNTIME_CANDIDATE_ONLY: "true", EOD_RUNTIME_PROBE_ID: "private-probe",
    EOD_CODE_REVISION: identity.codeRevision, EOD_RUNTIME_TARGET_DATABASE_ID: uuid(2) };
  const version = { id: runtimeIdentity.workerVersion, resources: { bindings: Object.entries(bindings).map(([name, value]) =>
    ["DB", "MARKET_DATA_DB", "MARKET_HISTORY_DB", "OPS_DB"].includes(name)
      ? { name, type: "d1", id: value, database_id: value } : { name, type: "plain_text", text: value }) } };
  const events = ["/api/dashboard", "/api/dashboard", "/api/breadth/dashboard", "/api/breadth/dashboard", EOD_RUNTIME_COORDINATOR_PATH]
    .flatMap((route, i) => {
      const summary: RuntimeProbeSummary = { event: "eod-runtime-probe-v1", probeId: "private-probe", sampleId: uuid(i + 10),
        category: i === 4 ? "coordinator" : "http", route, codeRevision: identity.codeRevision, workerVersion: uuid(6),
        targetDatabaseId: uuid(2), eodReadEnabled: true, startedAt: stamp, finishedAt: stamp, outcome: "ok", complete: true,
        cpuSource: "cloudflare-invocation-log-required", stats: { queries: i + 2, rowsRead: 10, rowsWritten: 1,
          maxQueryDurationMs: i + 0.5, missingMetadata: 0, failedQueries: 0 } };
      const worker = { requestId: `request-${i}`, scriptName: runtimeIdentity.workerName, scriptVersion: { id: uuid(6) } };
      return [{ source: JSON.stringify(summary), $workers: worker },
        { source: "invocation", $workers: { ...worker, cpuTimeMs: i + 1, outcome: "ok" } }];
    });
  return buildRuntimeEvidence(runtimeIdentity, version, events, { from: now - 30_000, to: now - 10_000 }, true);
}

describe("actual-evidence storage cutover builder", () => {
  let market: ReturnType<typeof createSqliteD1>, history: ReturnType<typeof createSqliteD1>, ops: ReturnType<typeof createSqliteD1>, env: Env;
  const tickers = ["AAA", "NONE"], runId = "eod:active:2026-09-08:daily";
  beforeEach(async () => {
    market = createSqliteD1(); history = createSqliteD1(); ops = createSqliteD1();
    market.migrate("market-data-migrations"); history.migrate("history-migrations"); ops.migrate("ops-migrations");
    env = { DB: market.db, MARKET_DATA_DB: market.db, MARKET_HISTORY_DB: history.db, OPS_DB: ops.db,
      EOD_CODE_REVISION: identity.codeRevision, EOD_RUNNER_MODE: "active", EOD_READ_ENABLED: "true" } as Env;
    const memberships = EOD_PUBLICATION_SCOPES.filter((scope) => scope.startsWith("breadth:")).map((scope) => ({
      universeId: scope.slice(8), versionId: `membership:${scope}`, members: ["AAA"] }));
    const config = { sections: [{ id: "macro", groups: [{ id: "indices", items: tickers.map((ticker) => ({ ticker, enabled: true })) }] }] };
    for (const scope of [...EOD_PUBLICATION_SCOPES, "history:catalog"]) {
      const catalog = scope === "history:catalog";
      const payload = catalog ? encodeEodCatalogPayload(identity.sessionDate, tickers.map((ticker) => buildEodCatalogRow(ticker, [], 0)))
        : scope === "overview:default" ? { status: "ready", freshnessCurrentCount: 1, asOfDate: identity.sessionDate,
          sections: [{ id: "macro", groups: [{ id: "indices", rows: tickers.map((ticker) => ({ ticker })) }] }] }
          : { asOfDate: identity.sessionDate, publishable: true, metrics: { memberCount: 1, totalUniverseMembers: 1 }, membership: { versionId: `membership:${scope}` } };
      await market.db.prepare(`INSERT INTO eod_publications(id,scope,session_date,revision,input_hash,methodology_version,payload_json,
        payload_checksum,payload_codec,status,created_at,accepted_at) VALUES(?,?,?,1,?,?,?,?,'json','accepted',?,?)`)
        .bind(`pub:${scope}`, scope, identity.sessionDate, `hash:${scope}`, catalog ? EOD_CATALOG_METHODOLOGY_VERSION : EOD_METRICS_VERSION,
          JSON.stringify(payload), await eodHash(payload), `${identity.sessionDate}T21:00:00Z`, `${identity.sessionDate}T21:00:00Z`).run();
      await market.db.prepare("INSERT INTO eod_publication_pointers(scope,publication_id,session_date,published_at) VALUES(?,?,?,?)")
        .bind(scope, `pub:${scope}`, identity.sessionDate, `${identity.sessionDate}T21:00:00Z`).run();
    }
    await ops.db.prepare(`INSERT INTO eod_runs(id,session_date,purpose,mode,status,input_json,progress_json,completed_at,completed_input_clock,created_at,updated_at)
      VALUES(?,?,'daily','active','completed',?,?,?,0,?,?)`).bind(runId, identity.sessionDate,
      JSON.stringify({ tickers, memberships, config, methodologyVersion: EOD_METRICS_VERSION }),
      JSON.stringify({ symbols: tickers.length, published: EOD_PUBLICATION_SCOPES.map((scope) => `pub:${scope}`), catalogPublicationId: "pub:history:catalog" }),
      `${identity.sessionDate}T21:01:00Z`, `${identity.sessionDate}T21:00:00Z`, `${identity.sessionDate}T21:01:00Z`).run();
    const date = new Date().toISOString().slice(0, 10);
    await ops.db.prepare("INSERT INTO eod_usage VALUES(?,1000,50,100,10)").bind(date).run();
    await ops.db.prepare("INSERT INTO eod_account_usage(usage_date,rows_read,rows_written,sampled_at) VALUES(?,2000,100,?)")
      .bind(date, new Date().toISOString()).run();
    await ops.db.prepare("INSERT INTO market_data_daily_usage(usage_date,rows_read,rows_written,updated_at) VALUES(?,2200,110,?)")
      .bind(date, new Date().toISOString()).run();
  }, 30_000);
  afterEach(() => { market.dispose(); history.dispose(); ops.dispose(); });
  async function fixture() {
    const consumers = (await verifyStorageConsumerBatch({ sourceEnv: env, targetEnv: env, capture, tickers,
      calendarDates: [identity.sessionDate], assertCapture: async () => {}, maxTickers: 2 })).evidence!;
    const publications = await verifyStorageAcceptedPublications({ env, identity, runId, tickers, expectedSession: identity.sessionDate });
    const stamp = new Date().toISOString(), tickerHash = await eodHash(tickers);
    const growth = { version: 1, measuredAt: stamp, codeRevision: identity.codeRevision, tickerHash, schemaHash: capture.sourceCapture.schemaHash,
      fixtureSha256: "e".repeat(64), beforeBytes: 4096, afterBytes: 12288, measurementMethod: "sqlite-real-publication-schema-v1",
      sourceSnapshotSha256: "f".repeat(64), sourcePublicationIds: publications.scopes.map((row) => row.id),
      sourcePublicationChecksums: publications.scopes.map((row) => row.checksum), sourceSessionDate: identity.sessionDate,
      samplesHash: "c".repeat(64), publicationEvidenceHash: publications.evidenceHash, completeSessionSets: 2, publicationRows: 14,
      forecastSessions: 20, revisionsPerSession: 2 };
    const analysis = { version: 1, measuredAt: stamp, sessionDate: identity.sessionDate,
      source: { snapshotSha256: "f".repeat(64), capture: { kind: "logical-d1-capacity-snapshot", completeDeclared: true, partialEstimate: false } },
      population: { count: 2, sha256: tickerHash }, archive: { withAdditionalCompleteRevisionAndTransientBytes: 2_000_000 },
      retentionModels: [260, 90].map((hotSessions) => ({ hotSessions, sweepHeadroomSessions: 10, sharedTickers: 2, fallbackTickerReserve: 2,
        modeledSipRows: 2 * (hotSessions + 10), modeledFallbackRows: 2 * (hotSessions + 10),
        preservedOtherFeedOrNonSharedSeedRows: 0,
        database: { physicalBytes: 2_000_000, priceTableAndIndexBytes: 1_000_000 }, publicationGrowthReserveBytes: 163840, projectedBytes: 2163840 })) };
    return { env, identity, runId, tickers, expectedSession: identity.sessionDate, capture, consumers, analysis,
      publicationGrowth: growth, sourceSnapshotSha256: "f".repeat(64), runtime: await runtimeFixture(), runtimeIdentity,
      assertSourceCapture: async () => {} };
  }
  it("derives the six scopes, all universe counts, parity, dual-feed model and actual usage without operator metrics", async () => {
    const built = await buildStorageCutoverEvidence(await fixture());
    expect(built.proof.sharedTickers).toEqual({ count: 2, processed: 2 });
    expect(built.proof.fullUniverseCounts).toHaveLength(5);
    expect(built.proof.fullUniverseCounts.every((row) => row.memberCount === 1 && row.attemptedCount === 1 && row.observedCount === 1)).toBe(true);
    expect(built.proof.scopes).toHaveLength(6);
    expect(built.proof.measurements).toMatchObject({ eodRowsRead: 1000, eodRowsWritten: 50, accountRowsRead: 2200, accountRowsWritten: 110,
      httpCpuMs: 4, coordinatorCpuMs: 5, queriesPerInvocation: 6, queryDurationMs: 4.5 });
    expect(built.proof.capacity.priceRows).toBe(1080);
    expect(built.proof.capacity.marketDatabaseBytes).toBe(2163840);
    expect(built.provenance.capacity.liveTargetBytes).toBeGreaterThan(0);
    expect(built.provenance.usage.reservedReads).toBe(100);
    expect(built.provenance.proofHash).toBe(await eodHash(built.proof));
    // An earlier attempt can approve the code then exhaust quota before the
    // migration becomes ready. Rebuilding the current proof must retain that
    // immutable code approval and independently record this storage acceptance.
    const approval = JSON.stringify({ originalCodeApproval: true });
    await ops.db.prepare("INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES(?,?,?)")
      .bind(`active:${identity.codeRevision}`, approval, new Date().toISOString()).run();
    const first = await storeStorageCutoverProof(ops.db, { identity, proof: built.proof, provenance: built.provenance });
    const replay = await storeStorageCutoverProof(ops.db, { identity, proof: built.proof, provenance: built.provenance });
    expect(replay).toEqual(first);
    const later = new Date(Date.now() + 1000), proof = { ...built.proof, measuredAt: later.toISOString() };
    const provenance = { ...built.provenance, proofHash: await eodHash(proof), measuredAt: later.toISOString() };
    const resumed = await storeStorageCutoverProof(ops.db, { identity, proof, provenance, now: later });
    expect(resumed.id).not.toBe(first.id);
    expect(resumed.record.proofHash).toBe(await eodHash(proof));
    expect(await ops.db.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?")
      .bind(`active:${identity.codeRevision}`).first<string>("evidence_json")).toBe(approval);
    expect(await ops.db.prepare("SELECT COUNT(*) AS count FROM eod_rollout_evidence WHERE id LIKE 'storage-cutover-proof:%'")
      .first<number>("count")).toBe(2);
  }, 30_000);
  it("fails on changed private inputs, missing fallback capacity, wrong runtime identity and stale parity", async () => {
    const input = await fixture();
    await expect(buildStorageCutoverEvidence({ ...input, runtimeIdentity: { ...runtimeIdentity, targetDatabaseId: uuid(99) } })).rejects.toThrow("identity-mismatch");
    const incomplete = structuredClone(input.analysis); incomplete.retentionModels.forEach((model) => { model.fallbackTickerReserve = 0; });
    await expect(buildStorageCutoverEvidence({ ...input, analysis: incomplete })).rejects.toThrow("capacity-headroom-missing");
    const stale = { ...input.consumers, completedAt: new Date(Date.now() - 8 * 86_400_000).toISOString() };
    const { evidenceHash: _, ...unsigned } = stale; stale.evidenceHash = await eodHash(unsigned);
    await expect(buildStorageCutoverEvidence({ ...input, consumers: stale })).rejects.toThrow("current archive parity");
    await market.db.prepare("UPDATE eod_input_clock SET revision=revision+1 WHERE id='default'").run();
    await expect(buildStorageCutoverEvidence(input)).rejects.toThrow("publication-inputs-changed");
  }, 30_000);
  it("requires current account telemetry and counts outstanding reservations without claiming they were billed", async () => {
    const date = new Date().toISOString().slice(0, 10);
    await ops.db.prepare("UPDATE eod_usage SET reserved_reads=2499500 WHERE usage_date=?").bind(date).run();
    await expect(collectStorageCutoverUsage(ops.db)).rejects.toThrow("quota-headroom-unavailable");
    await ops.db.prepare("UPDATE eod_usage SET reserved_reads=100 WHERE usage_date=?").bind(date).run();
    await ops.db.prepare("UPDATE market_data_daily_usage SET rows_written=89999 WHERE usage_date=?").bind(date).run();
    await expect(collectStorageCutoverUsage(ops.db)).rejects.toThrow("quota-headroom-unavailable");
    await ops.db.prepare("UPDATE eod_account_usage SET sampled_at=? WHERE usage_date=?")
      .bind(new Date(Date.now() - 301_000).toISOString(), date).run();
    await expect(collectStorageCutoverUsage(ops.db)).rejects.toThrow("account-usage-stale");
    await ops.db.prepare("DELETE FROM eod_account_usage WHERE usage_date=?").bind(date).run();
    await expect(collectStorageCutoverUsage(ops.db)).rejects.toThrow("current-account-and-eod-usage-required");
  }, 30_000);
});
