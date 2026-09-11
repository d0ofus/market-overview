import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCapacityLocalSqlite } from "../scripts/eod-capacity-local-sqlite";
import { inspectStorageCapacityRenewal, claimStorageCapacityRenewal, finishStorageCapacityRenewal, loadStorageCapacityRenewalStatus,
  captureOpenStorageDatabase, assertStorageCapacityCapture, assertStorageCapacityRevisions, storageCapacityRenewalKey,
  storeRenewedStorageHistoryMaintenanceApproval, type StorageCapacityCapture, type StorageCapacityRenewalDue } from "../src/eod-storage-capacity-renewal";
import { loadStorageHistoryMaintenanceApproval, type StorageHistoryMaintenanceApproval } from "../src/eod-storage-history-capacity";
import { loadEodInputs } from "../src/eod-runner";
import { assertEodCutover } from "../src/eod-rollout-service";
import { eodHash } from "../src/eod-publication-service";
import { prepareStorageSourceFence } from "../src/market-storage-fence";
import { STORAGE_CONSUMER_CONTRACTS, type StorageConsumerEvidence } from "../src/market-storage-acceptance";
import { EOD_PUBLICATION_SCOPES } from "../src/eod-coordinator";
import type { Env } from "../src/types";

vi.mock("../src/eod-runner", () => ({ loadEodInputs: vi.fn() }));
vi.mock("../src/eod-storage-history-capacity", () => ({ loadStorageHistoryMaintenanceApproval: vi.fn() }));
vi.mock("../src/eod-rollout-service", () => ({ assertEodCutover: vi.fn() }));
const revision = "a".repeat(40), hash = "b".repeat(64), now = new Date("2026-11-27T18:30:00Z");
const identity = { id: "market-storage:test", codeRevision: revision, sessionDate: "2026-11-27",
  sourceDatabaseId: "10000000-0000-0000-0000-000000000001", targetDatabaseId: "10000000-0000-0000-0000-000000000002", historyDatabaseId: "10000000-0000-0000-0000-000000000003" };
describe("automatic storage capacity renewal contracts", () => {
  let directory: string, local: ReturnType<typeof createCapacityLocalSqlite>, env: Env, previous: StorageHistoryMaintenanceApproval;
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "eod-renewal-test-")); local = createCapacityLocalSqlite(join(directory, "test.sqlite"));
    await local.script(`CREATE TABLE eod_rollout_evidence(id TEXT PRIMARY KEY,evidence_json TEXT,updated_at TEXT);
      CREATE TABLE eod_runs(id TEXT PRIMARY KEY,mode TEXT,purpose TEXT,status TEXT,session_date TEXT,completed_at TEXT);
      CREATE TABLE market_calendar_sessions(session_date TEXT PRIMARY KEY,close_at TEXT);
      CREATE TABLE market_calendar_refresh_state(id TEXT PRIMARY KEY,covered_start TEXT,covered_end TEXT);
      CREATE TABLE eod_input_clock(id TEXT PRIMARY KEY,revision INTEGER);
      INSERT INTO eod_input_clock VALUES('default',4);
      INSERT INTO market_calendar_refresh_state VALUES('default','2026-01-01','2027-12-31');
      INSERT INTO market_calendar_sessions VALUES('2026-11-25','16:00'),('2026-11-27','13:00'),('2026-11-30','16:00');
      INSERT INTO eod_runs VALUES('run','active','daily','completed','2026-11-27','2026-11-27T18:10:00Z');
      CREATE TABLE market_storage_fence(id TEXT PRIMARY KEY,status TEXT,revision INTEGER,released_at TEXT,migration_id TEXT,code_revision TEXT,schema_hash TEXT,snapshot_revision INTEGER);
      INSERT INTO market_storage_fence(id,status,revision) VALUES('default','open',7);
      CREATE TABLE market_storage_migrations(id TEXT PRIMARY KEY,status TEXT,target_database_id TEXT,history_database_id TEXT,source_database_id TEXT,code_revision TEXT);`);
    env = { DB: local.db, MARKET_DATA_DB: local.db, MARKET_HISTORY_DB: local.db, OPS_DB: local.db, EOD_RUNNER_MODE: "active", EOD_CODE_REVISION: revision } as Env;
    previous = { version: 1, kind: "storage-layout-v1", codeRevision: revision, approvedAt: "2026-10-01T20:00:00Z", proofHash: hash,
      proof: { identity, tickers: ["AAA"], tickerHash: await eodHash(["AAA"]), publicationRunId: "old", consumerProofHash: hash,
        readers: { contractVersion: 1, checkedAt: "2026-10-01T20:00:00Z", codeRevision: revision, parityPassed: true, consumers: [] },
        capacity: { hotSessions: 90, projectedMarketBytes: 1_500_000, projectedHistoryBytes: 2_000_000, liveTargetBytes: 1_000_000,
          liveHistoryBytes: 1_000_000, publicationGrowthReserveBytes: 500_000, forecastSessions: 20, revisionsPerSession: 2, analysisHash: hash, measuredAt: "2026-10-01T20:00:00Z" },
        model: { measuredAt: "2026-10-01T20:00:00Z", sourceSnapshotHash: hash, priceTableAndIndexBytes: 40_000, modeledPriceRows: 200,
          fullLayoutBytes: 1_000_000, hotSessions: 90, sweepHeadroomSessions: 10 },
        horizon: { anchorSession: "2026-10-01", lastCoveredSession: "2026-11-30", expiresAt: "2026-12-01T00:00:00Z", sessions: 20 } } };
    vi.mocked(loadStorageHistoryMaintenanceApproval).mockResolvedValue(previous);
    vi.mocked(loadEodInputs).mockResolvedValue({ tickers: ["AAA"], calendarDates: [], memberships: [], config: {} } as never);
    vi.mocked(assertEodCutover).mockResolvedValue(null);
  });
  afterEach(async () => { await local.close(); rmSync(directory, { recursive: true, force: true }); vi.clearAllMocks(); });
  it("uses actual NY sessions across the early close, UTC midnight, holiday and future calendar", async () => {
    expect((await inspectStorageCapacityRenewal(env, new Date("2026-11-27T17:59:00Z"))).sessionDate).toBe("2026-11-25");
    expect((await inspectStorageCapacityRenewal(env, new Date("2026-11-27T18:00:00Z"))).sessionDate).toBe("2026-11-27");
    expect((await inspectStorageCapacityRenewal(env, new Date("2026-11-28T00:30:00Z"))).sessionDate).toBe("2026-11-27");
    expect((await inspectStorageCapacityRenewal(env, new Date("2026-11-29T15:00:00Z"))).sessionDate).toBe("2026-11-27");
    expect((await inspectStorageCapacityRenewal(env, now)).remainingSessions).toBe(1);
  });
  it("renews a changed catalog population even with a distant forecast and does not remove missing members", async () => {
    previous.proof.horizon.lastCoveredSession = "2026-12-31";
    for (let index = 1; index <= 10; index++) await local.db.prepare("INSERT INTO market_calendar_sessions VALUES(?,'16:00')").bind(`2026-12-${String(index).padStart(2,"0")}`).run();
    expect(await inspectStorageCapacityRenewal(env, now)).toMatchObject({ needed: false, reason: "current" });
    vi.mocked(loadEodInputs).mockResolvedValue({ tickers: ["AAA", "MISSING"], calendarDates: [], memberships: [], config: {} } as never);
    expect(await inspectStorageCapacityRenewal(env, now)).toMatchObject({ needed: true, reason: "population-changed", populationHash: await eodHash(["AAA", "MISSING"]) });
  });
  it("grants a single durable lease, preserves quota cooldown and detects an interrupted owner", async () => {
    const due = await inspectStorageCapacityRenewal(env, now);
    const claimed = await claimStorageCapacityRenewal(local.db, due, now);
    expect(claimed).not.toBeNull(); expect(await claimStorageCapacityRenewal(local.db, due, now)).toBeNull();
    expect(await loadStorageCapacityRenewalStatus(env, new Date(now.getTime() + 4 * 60 * 60_000))).toMatchObject({ status: "failed", error: "attempt-interrupted" });
    await finishStorageCapacityRenewal(local.db, claimed!, { error: "quota-exhausted", quota: true }, now);
    expect(await loadStorageCapacityRenewalStatus(env, now)).toMatchObject({ status: "failed", nextAttemptAt: "2026-11-28T00:05:00.000Z" });
    expect(await claimStorageCapacityRenewal(local.db, due, new Date("2026-11-28T00:04:59Z"))).toBeNull();
    expect(await claimStorageCapacityRenewal(local.db, due, new Date("2026-11-28T00:05:00Z"))).not.toBeNull();
    await expect(finishStorageCapacityRenewal(local.db, claimed!, { proofHash: hash }, now)).rejects.toThrow("lease-lost");
  });
  it.each([{ status: "anything" }, { stage: "Bearer secret" }, { error: "https://secret" }, { nextAttemptAt: "tomorrow" }])("rejects unsafe cached public diagnostics %j", async (change) => {
    const due = await inspectStorageCapacityRenewal(env, now), status = await claimStorageCapacityRenewal(local.db, due, now);
    await local.db.prepare("UPDATE eod_rollout_evidence SET evidence_json=? WHERE id=?").bind(JSON.stringify({ ...status, ...change }), storageCapacityRenewalKey(revision)).run();
    await expect(loadStorageCapacityRenewalStatus(env, now)).rejects.toThrow("status-invalid");
  });
  it("trusts only complete open write tracking and rejects changed prices without rereading membership", async () => {
    const plan = await prepareStorageSourceFence(local.db);
    await local.script(plan.statements.map((row) => row.sql).join("\n"));
    const actual = await captureOpenStorageDatabase(local.db);
    const capture: StorageCapacityCapture = { version: 1, market: actual, history: actual, inputClock: 4, populationHash: hash,
      runId: "run", sessionDate: "2026-11-27", codeRevision: revision, capturedAt: now.toISOString() };
    await expect(assertStorageCapacityRevisions(env, capture)).resolves.toBeUndefined();
    await local.db.prepare("UPDATE eod_input_clock SET revision=5 WHERE id='default'").run();
    await expect(assertStorageCapacityRevisions(env, capture)).rejects.toThrow("inputs-changed");
    expect(() => assertStorageCapacityCapture(capture, { ...capture, market: { ...actual, revision: actual.revision + 1 } })).toThrow("inputs-changed");
    await local.db.prepare("UPDATE market_storage_fence SET released_at=? WHERE id='default'").bind(now.toISOString()).run();
    await expect(captureOpenStorageDatabase(local.db)).rejects.toThrow("tracking-incomplete");
  });
  it("does not normalize away a changed trigger string literal", async () => {
    const plan = await prepareStorageSourceFence(local.db);
    const statements = plan.statements.map((row) => row.sql);
    statements[0] = statements[0].replace("='frozen'", "='fro zen'");
    await local.script(statements.join("\n"));
    await expect(captureOpenStorageDatabase(local.db)).rejects.toThrow("tracking-incomplete");
  });
  async function renewal() {
    const due: StorageCapacityRenewalDue = { ...(await inspectStorageCapacityRenewal(env, now)), needed: true };
    const status = (await claimStorageCapacityRenewal(local.db, due, now))!;
    const capture: StorageCapacityCapture = { version: 1, market: { schemaHash: hash, revision: 7 }, history: { schemaHash: hash, revision: 7 },
      inputClock: 4, populationHash: await eodHash(["AAA"]), runId: "run", sessionDate: identity.sessionDate, codeRevision: revision, capturedAt: now.toISOString() };
    const consumerCapture = { identity, captureHash: await eodHash(capture), sourceCapture: capture.market, targetCapture: capture.market, historyCapture: capture.history };
    const unsigned = { version: 1 as const, inputHash: hash, tickerHash: capture.populationHash, tickerCount: 1, nextTicker: 1, outputHash: hash,
      checks: Object.fromEntries(STORAGE_CONSUMER_CONTRACTS.map((name) => [name, { tickers: 1, observations: 1, hash }])) as StorageConsumerEvidence["checks"],
      history: { missing: 0, shorterThan520: 1, shorterThan1330: 1 }, completedAt: now.toISOString(), captureHash: consumerCapture.captureHash, identity, readerContractVersion: 1 };
    const consumers = { ...unsigned, evidenceHash: await eodHash(unsigned) };
    const pub = { version: 1 as const, identity, runId: "run", sessionDate: identity.sessionDate, inputClock: 4, tickerHash: capture.populationHash,
      tickerCount: 1, checkedAt: now.toISOString(), scopes: [...EOD_PUBLICATION_SCOPES,"history:catalog"].map((scope) => ({ scope,id:scope,revision:1,checksum:hash })), membershipHash: hash, catalogHash: hash };
    const analysis = { measuredAt: now.toISOString(), source: { snapshotSha256: hash }, retentionModels: [{ hotSessions: 90,
      sharedTickers: 1, fallbackTickerReserve: 1, sweepHeadroomSessions: 10, modeledSipRows: 100, modeledFallbackRows: 100,
      projectedBytes: 1_500_000, database: { physicalBytes: 1_000_000, priceTableAndIndexBytes: 40_000 } }] };
    const capacity = { ...previous.proof.capacity, analysisHash: await eodHash(analysis), measuredAt: now.toISOString() };
    await local.db.prepare("INSERT INTO market_storage_migrations VALUES(?,?,?,?,?,?)").bind(identity.id, "completed", identity.targetDatabaseId, identity.historyDatabaseId, identity.sourceDatabaseId, revision).run();
    await local.db.prepare("INSERT INTO eod_rollout_evidence VALUES(?,?,?)").bind("monitoring:public-activation", JSON.stringify({ marketDatabaseId: identity.targetDatabaseId, codeRevision: revision }), now.toISOString()).run();
    await local.db.prepare("INSERT INTO eod_rollout_evidence VALUES(?,?,?)").bind(`active:${revision}`, "{}", now.toISOString()).run();
    for (let index = 1; index <= 25; index++) await local.db.prepare("INSERT INTO market_calendar_sessions VALUES(?,'16:00')").bind(`2026-12-${String(index).padStart(2,"0")}`).run();
    return { previous, status, capture, consumerCapture, consumers, publications: { ...pub, evidenceHash: await eodHash(pub) }, capacity, analysis, tickers: ["AAA"], assertCapture: vi.fn(async () => undefined), now };
  }
  it("publishes a fresh immutable model and full reader proof while keeping dated prior evidence", async () => {
    const input = await renewal(); const approved = await storeRenewedStorageHistoryMaintenanceApproval(env, input);
    expect(approved.proofHash).not.toBe(previous.proofHash); expect(approved.proof.model.measuredAt).toBe(now.toISOString());
    expect(previous.proof.model.measuredAt).toBe("2026-10-01T20:00:00Z");
    expect((approved.proof as unknown as { renewal: { previousReaders: unknown } }).renewal.previousReaders).toEqual(previous.proof.readers);
    expect(await local.db.prepare("SELECT COUNT(*) AS n FROM eod_rollout_evidence WHERE id=?").bind(`history-storage-proof:${approved.proofHash}`).first("n")).toBe(1);
    expect(input.assertCapture).toHaveBeenCalledTimes(1);
  });
  it("does not advance approval after changed capture, stale measurements or capacity overflow", async () => {
    const input = await renewal();
    input.assertCapture.mockRejectedValueOnce(new Error("input-changed"));
    await expect(storeRenewedStorageHistoryMaintenanceApproval(env, input)).rejects.toThrow("input-changed");
    await expect(storeRenewedStorageHistoryMaintenanceApproval(env, { ...input, capacity: { ...input.capacity, measuredAt: "2026-10-01T20:00:00Z" } })).rejects.toThrow("measurement-expired");
    await expect(storeRenewedStorageHistoryMaintenanceApproval(env, { ...input, capacity: { ...input.capacity, projectedHistoryBytes: 350_000_000 } })).rejects.toThrow("measured-layout");
    expect(await local.db.prepare("SELECT COUNT(*) AS n FROM eod_rollout_evidence WHERE id=?").bind(`history-storage-approval:${revision}`).first("n")).toBe(0);
  });
});
