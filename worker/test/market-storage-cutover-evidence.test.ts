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
import { createStorageMigration } from "../src/market-storage-control";
import { storageExecutionKey } from "../src/market-storage-execution";
import { composeStorageConsumerProof, storagePopulationCompositeKey, storagePopulationExpansionKey } from "../src/market-storage-consumer-composite";
import { storeStorageHistoryMaintenanceApproval } from "../src/eod-storage-history-capacity";
import type { FrozenInputs } from "../src/eod-runner";
import type { StoragePopulationPlan } from "../src/market-storage-population-plan";
import type { StoragePopulationExpansionRecord } from "../src/market-storage-population-expansion";
import { createSqliteD1 } from "./helpers/sqlite-d1";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { id: "market-storage:test", sourceDatabaseId: uuid(1), targetDatabaseId: uuid(2), historyDatabaseId: uuid(3),
  sessionDate: "2026-09-08", codeRevision: "a".repeat(40) };
const capture: StorageAcceptanceCapture = { identity, captureHash: "b".repeat(64),
  sourceCapture: { schemaHash: "c".repeat(64), revision: 0 }, targetCapture: { schemaHash: "c".repeat(64), revision: 0 },
  historyCapture: { schemaHash: "d".repeat(64), revision: 0 } };
const runtimeIdentity: RuntimeEvidenceIdentity = { probeId: "private-probe", workerName: "candidate", workerVersion: uuid(6),
  codeRevision: identity.codeRevision, targetDatabaseId: uuid(2), historyDatabaseId: uuid(3), opsDatabaseId: uuid(4), coreDatabaseId: uuid(5) };
async function runtimeFixture(revision = identity.codeRevision) {
  const now = Date.now(), stamp = new Date(now - 20_000).toISOString();
  const bindings = { DB: uuid(5), MARKET_DATA_DB: uuid(2), MARKET_HISTORY_DB: uuid(3), OPS_DB: uuid(4),
    EOD_READ_ENABLED: "true", EOD_RUNTIME_CANDIDATE_ONLY: "true", EOD_RUNTIME_PROBE_ID: "private-probe",
    EOD_CODE_REVISION: revision, EOD_RUNTIME_TARGET_DATABASE_ID: uuid(2) };
  const version = { id: runtimeIdentity.workerVersion, resources: { bindings: Object.entries(bindings).map(([name, value]) =>
    ["DB", "MARKET_DATA_DB", "MARKET_HISTORY_DB", "OPS_DB"].includes(name)
      ? { name, type: "d1", id: value, database_id: value } : { name, type: "plain_text", text: value }) } };
  const events = ["/api/dashboard", "/api/dashboard", "/api/breadth/dashboard", "/api/breadth/dashboard", EOD_RUNTIME_COORDINATOR_PATH]
    .flatMap((route, i) => {
      const summary: RuntimeProbeSummary = { event: "eod-runtime-probe-v1", probeId: "private-probe", sampleId: uuid(i + 10),
        category: i === 4 ? "coordinator" : "http", route, codeRevision: revision, workerVersion: uuid(6),
        targetDatabaseId: uuid(2), eodReadEnabled: true, startedAt: stamp, finishedAt: stamp, outcome: "ok", complete: true,
        cpuSource: "cloudflare-invocation-log-required", stats: { queries: i + 2, rowsRead: 10, rowsWritten: 1,
          maxQueryDurationMs: i + 0.5, missingMetadata: 0, failedQueries: 0 } };
      const worker = { requestId: `request-${i}`, scriptName: runtimeIdentity.workerName, scriptVersion: { id: uuid(6) } };
      return [{ source: JSON.stringify(summary), $metadata: { type: "cf-worker-log" }, $workers: worker },
        { source: "invocation", $metadata: { type: "cf-worker-event" }, $workers: { ...worker, cpuTimeMs: i + 1, outcome: "ok" } }];
    });
  return buildRuntimeEvidence({ ...runtimeIdentity, codeRevision: revision }, version, events, { from: now - 30_000, to: now - 10_000 }, true);
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
    const executionIdentity = { ...identity, codeRevision: env.EOD_CODE_REVISION! };
    const consumers = (await verifyStorageConsumerBatch({ sourceEnv: env, targetEnv: env, capture, tickers,
      calendarDates: [identity.sessionDate], assertCapture: async () => {}, maxTickers: 2 })).evidence!;
    const publications = await verifyStorageAcceptedPublications({ env, identity: executionIdentity, runId, tickers, expectedSession: identity.sessionDate });
    const stamp = new Date().toISOString(), tickerHash = await eodHash(tickers);
    const growth = { version: 1, measuredAt: stamp, codeRevision: executionIdentity.codeRevision, tickerHash, schemaHash: capture.sourceCapture.schemaHash,
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
      publicationGrowth: growth, sourceSnapshotSha256: "f".repeat(64), runtime: await runtimeFixture(executionIdentity.codeRevision),
      runtimeIdentity: { ...runtimeIdentity, codeRevision: executionIdentity.codeRevision },
      assertSourceCapture: async () => {} };
  }
  it("binds fresh runtime and publications to the approved executor while preserving the original capture", async () => {
    const revision = "d".repeat(40), freezeHash = "e".repeat(64);
    await createStorageMigration(ops.db, identity);
    const unsigned = { version: 1, policy: "preserve-storage-capture-execution-v1", storageIdentity: identity,
      fromRevision: identity.codeRevision, codeRevision: revision, predecessorHash: null,
      sourceCapture: capture.sourceCapture, freezeEvidenceHash: freezeHash, checkpointCount: 0,
      checkpointManifestHash: "f".repeat(64), changedFiles: ["worker/src/eod-budget-profile.ts"], diffHash: "a".repeat(64),
      approvedAt: new Date().toISOString(), storagePolicy: { hotSessions: 90, marketBytes: 350_000_000,
        archiveBytes: 350_000_000, databaseCount: 10, accountBytes: 5_000_000_000 } };
    const record = { ...unsigned, evidenceHash: await eodHash(unsigned) };
    await ops.db.prepare("UPDATE market_storage_migrations SET source_schema_hash=?,source_revision=0,freeze_evidence_hash=?,execution_revision=?,execution_evidence_hash=? WHERE id=?")
      .bind(capture.sourceCapture.schemaHash, freezeHash, revision, record.evidenceHash, identity.id).run();
    await ops.db.prepare("INSERT INTO eod_rollout_evidence VALUES(?,?,?)")
      .bind(storageExecutionKey(identity.id, revision), JSON.stringify(record), unsigned.approvedAt).run();
    env.EOD_CODE_REVISION = revision;
    const input = await fixture(), built = await buildStorageCutoverEvidence(input);
    expect(built.proof.codeRevision).toBe(revision);
    expect(built.provenance).toMatchObject({ identity: { ...identity, codeRevision: revision }, storageIdentity: identity,
      executionApprovalHash: record.evidenceHash, captureHash: capture.captureHash });
    expect(input.capture.identity.codeRevision).toBe(identity.codeRevision);
    await ops.db.prepare("DELETE FROM eod_rollout_evidence WHERE id=?").bind(storageExecutionKey(identity.id, revision)).run();
    await expect(buildStorageCutoverEvidence(input)).rejects.toThrow("storage-execution-record-invalid");
  }, 30_000);
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
  it("accepts a stored disjoint proof downstream without redating the original parity or mutating accepted publications", async () => {
    const input = await fixture();
    await createStorageMigration(ops.db, identity);
    const baseline = (await verifyStorageConsumerBatch({ sourceEnv: env, targetEnv: env, capture,
      tickers: ["AAA"], calendarDates: [identity.sessionDate], assertCapture: async () => {}, maxTickers: 1 })).evidence!;
    const deltaFields = { identity, sourceCapture: capture.sourceCapture,
      targetCapture: { ...capture.targetCapture, revision: 1 }, historyCapture: { ...capture.historyCapture, revision: 1 } };
    const deltaCapture = { ...deltaFields, captureHash: await eodHash(deltaFields) };
    const delta = (await verifyStorageConsumerBatch({ sourceEnv: env, targetEnv: env, capture: deltaCapture,
      tickers: ["NONE"], calendarDates: [identity.sessionDate], assertCapture: async () => {}, maxTickers: 1 })).evidence!;
    const originalParityBytes = JSON.stringify(baseline), stamp = new Date().toISOString();
    const frozen = JSON.parse((await ops.db.prepare("SELECT input_json FROM eod_runs WHERE id=?")
      .bind(runId).first<string>("input_json"))!) as FrozenInputs;
    const parentFields = { version: 1 as const, codeRevision: identity.codeRevision, sourcePreflightHash: "1".repeat(64),
      sourceSnapshotHash: input.sourceSnapshotSha256, originalCopyCaptureHash: "2".repeat(64), createdAt: baseline.completedAt,
      sessionDate: identity.sessionDate, inputs: { ...frozen, tickers: ["AAA"], calendarDates: [identity.sessionDate] },
      capture, tickers: ["AAA"], calendarDates: [identity.sessionDate] };
    const parent: StoragePopulationPlan = { ...parentFields, planHash: await eodHash(parentFields) };
    const absenceFields = { version: 1 as const, migrationId: identity.id, addedTickerHash: await eodHash(["NONE"]),
      baselineHash: "3".repeat(64), baselineCaptureHash: "4".repeat(64), pointerRows: 0, pointerPages: 1,
      pointerHash: "5".repeat(64), blockRows: 0, blockPages: 1, blockHash: "6".repeat(64), checkedAt: stamp };
    const recordFields = { version: 1 as const, policy: "append-only-population-delta-v1" as const,
      migrationId: identity.id, codeRevision: identity.codeRevision, previousPlanHash: parent.planHash,
      previousConsumerProofHash: baseline.evidenceHash, previousTickerHash: await eodHash(parent.tickers), addedTickers: ["NONE"],
      nextTickerHash: await eodHash(tickers), nextInputsHash: await eodHash(frozen), sessionDate: identity.sessionDate,
      originalCopyCaptureHash: parent.originalCopyCaptureHash, sourceSnapshotHash: input.sourceSnapshotSha256,
      sourceAbsence: { ...absenceFields, evidenceHash: await eodHash(absenceFields) }, deltaCapture,
      deltaEvidenceHash: delta.evidenceHash, sizingHash: "7".repeat(64), createdAt: stamp };
    const record: StoragePopulationExpansionRecord = { ...recordFields, evidenceHash: await eodHash(recordFields) };
    const consumers = await composeStorageConsumerProof({ capture, baselineTickers: parent.tickers, baseline,
      deltaCapture, addedTickers: ["NONE"], delta, expansionHash: record.evidenceHash, now: new Date(stamp) });
    await ops.db.prepare("INSERT INTO market_storage_checkpoints VALUES(?,?,?,?,?)")
      .bind(identity.id, "consumer-parity:complete", capture.captureHash, originalParityBytes, baseline.completedAt).run();
    for (const [id, value] of [
      [`storage-population-plan:${identity.id}:${parent.planHash}`, parent],
      [storagePopulationExpansionKey(record.evidenceHash), record],
      [storagePopulationCompositeKey(record.evidenceHash), consumers],
    ] as const) await ops.db.prepare("INSERT INTO eod_rollout_evidence VALUES(?,?,?)").bind(id, JSON.stringify(value), stamp).run();
    const publicationBytes = JSON.stringify((await market.db.prepare("SELECT * FROM eod_publications ORDER BY id").all()).results);
    const built = await buildStorageCutoverEvidence({ ...input, consumers });
    expect(built.provenance.consumerEvidenceHash).toBe(consumers.evidenceHash);
    expect(built.proof.sharedTickers).toEqual({ count: 2, processed: 2 });
    expect(built.proof.readers.checkedAt).toBe(baseline.completedAt);
    for (let day = 9; day <= 28; day++) await market.db.prepare(
      "INSERT INTO market_calendar_sessions(session_date,open_at,close_at,source) VALUES(?,'09:30','16:00','fixture')")
      .bind(`2026-09-${String(day).padStart(2, "0")}`).run();
    const approval = await storeStorageHistoryMaintenanceApproval(env, { capacity: built.capacity, analysis: input.analysis,
      publications: built.publications, consumers, capture, tickers });
    expect(approval.proof).toMatchObject({ consumerProofHash: consumers.evidenceHash, tickers,
      readers: { checkedAt: baseline.completedAt }, model: { measuredAt: input.analysis.measuredAt } });
    expect(await ops.db.prepare("SELECT payload_json FROM market_storage_checkpoints WHERE migration_id=? AND checkpoint_key='consumer-parity:complete'")
      .bind(identity.id).first<string>("payload_json")).toBe(originalParityBytes);
    expect(JSON.stringify((await market.db.prepare("SELECT * FROM eod_publications ORDER BY id").all()).results)).toBe(publicationBytes);
    await ops.db.prepare("DELETE FROM eod_rollout_evidence WHERE id=?").bind(storagePopulationExpansionKey(record.evidenceHash)).run();
    await expect(buildStorageCutoverEvidence({ ...input, consumers })).rejects.toThrow("record-missing");
    await expect(storeStorageHistoryMaintenanceApproval(env, { capacity: built.capacity, analysis: input.analysis,
      publications: built.publications, consumers, capture, tickers })).rejects.toThrow("record-missing");
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
