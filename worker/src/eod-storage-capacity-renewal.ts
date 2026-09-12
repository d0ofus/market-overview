import { authenticateStorageRenewalArchiveContext,storageAcceptedArchiveForecast,validateStorageCurrentArchiveReport } from "./eod-current-archive-validation";
import { eodHash } from "./eod-publication-service";
import { loadEodInputs } from "./eod-runner";
import { expectedEodSession, EOD_PUBLICATION_SCOPES } from "./eod-coordinator";
import { assertEodCutover } from "./eod-rollout-service";
import { loadStorageHistoryMaintenanceApproval, type StorageHistoryMaintenanceApproval } from "./eod-storage-history-capacity";
import { prepareStorageSourceFence } from "./market-storage-fence";
import { loadStorageMigration, storageExecutionRevision } from "./market-storage-control";
import { validateStorageConsumerEvidence, type StorageAcceptanceCapture, type StorageConsumerEvidence,
  type StoragePublicationEvidence, type validateStorageCapacityAnalysis } from "./market-storage-acceptance";
import { MARKET_HISTORY_REQUIRED_CONSUMERS } from "./eod-history-maintenance";
import { EOD_YAHOO_ARCHIVE_LAYOUT, storageFallbackModelValid } from "./eod-storage-layout";
import type { Env } from "./types";

export const STORAGE_CAPACITY_RENEWAL_LEAD_SESSIONS = 5;
// The CLI is bounded to 70 minutes and its workflow to 80; a 90-minute lease lets
// the next two-hour scheduled opportunity recover an abruptly killed runner.
export const STORAGE_CAPACITY_RENEWAL_LEASE_MS = 90 * 60_000;
export type StorageCapacityRenewalStatus = {
  version: 1; codeRevision: string; attemptId: string; status: "running" | "failed" | "completed";
  stage: string; updatedAt: string; leaseUntil: string | null; nextAttemptAt: string | null;
  error: string | null; previousProofHash: string; populationHash: string; progress: Record<string, number | string>;
};
export type StorageCapacityRenewalDue = {
  needed: boolean; reason: "not-activated" | "no-storage-approval" | "population-changed" | "forecast-due" | "current";
  codeRevision: string; previousProofHash: string | null; populationHash: string | null;
  runId: string | null; sessionDate: string | null; remainingSessions: number;
};
type DatabaseCapture = { schemaHash: string; revision: number };
export type StorageCapacityCapture = { version: 1; market: DatabaseCapture; history: DatabaseCapture;
  inputClock: number; populationHash: string; runId: string; sessionDate: string; codeRevision: string; capturedAt: string };
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function fail(reason: string): never { throw new Error(`eod-capacity-renewal-${reason}`); }
const sorted = (values: string[]) => [...values].sort();
export const storageCapacityRenewalKey = (revision: string): string => `history-capacity-renewal:${revision}`;
async function read<T>(db: D1Database, id: string): Promise<T | null> {
  const raw = await db.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?").bind(id).first<string>("evidence_json");
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return fail("stored-json-invalid"); }
}

/** A bounded, read-only due check. It includes the current configuration,
 * verified memberships and active catalog, not just yesterday's catalog rows. */
export async function inspectStorageCapacityRenewal(env: Env, now = new Date()): Promise<StorageCapacityRenewalDue> {
  const codeRevision = env.EOD_CODE_REVISION ?? "";
  const empty = { needed: false, codeRevision, previousProofHash: null, populationHash: null,
    runId: null, sessionDate: null, remainingSessions: 0 };
  if (env.EOD_RUNNER_MODE !== "active" || !env.OPS_DB || !env.MARKET_DATA_DB || !env.MARKET_HISTORY_DB) return { ...empty, reason: "not-activated" };
  const approved = await loadStorageHistoryMaintenanceApproval(env, codeRevision);
  if (!approved) return { ...empty, reason: "no-storage-approval" };
  const sessionDate = await expectedEodSession(env, now);
  if (!sessionDate) fail("calendar-incomplete");
  const inputs = await loadEodInputs(env, sessionDate), populationHash = await eodHash(sorted(inputs.tickers));
  const run = await env.OPS_DB.prepare(`SELECT id FROM eod_runs WHERE mode='active' AND purpose='daily'
    AND status='completed' AND session_date=? ORDER BY completed_at DESC LIMIT 1`).bind(sessionDate).first<{ id: string }>();
  const remaining = await env.MARKET_DATA_DB.prepare(`SELECT session_date FROM market_calendar_sessions
    WHERE session_date>? AND session_date<=? ORDER BY session_date LIMIT 1301`)
    .bind(sessionDate, approved.proof.horizon.lastCoveredSession).all<{ session_date: string }>();
  const changed = populationHash !== approved.proof.tickerHash;
  const due = remaining.results.length <= STORAGE_CAPACITY_RENEWAL_LEAD_SESSIONS
    || now.getTime() >= Date.parse(approved.proof.horizon.expiresAt);
  return { needed: changed || due, reason: changed ? "population-changed" : due ? "forecast-due" : "current", codeRevision,
    previousProofHash: approved.proofHash, populationHash, runId: run?.id ?? null, sessionDate, remainingSessions: remaining.results.length };
}

/** Verify every write guard before trusting its monotonic revision. A released
 * rollback fence stops counting and is explicitly unsuitable for a capture. */
export async function captureOpenStorageDatabase(db: D1Database): Promise<DatabaseCapture> {
  const plan = await prepareStorageSourceFence(db);
  const state = await db.prepare("SELECT status,revision,released_at FROM market_storage_fence WHERE id='default'")
    .first<{ status: string; revision: number; released_at: string | null }>();
  const guards = await db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name LIKE 'market_storage_guard_%'").all<{ sql: string }>();
  const normalize = (sql: string) => {
    const input = sql.replace(/^\s*CREATE\s+TRIGGER\s+IF\s+NOT\s+EXISTS\s+/i, "CREATE TRIGGER ");
    let output = "", quote: string | null = null;
    for (let index = 0; index < input.length; index++) {
      const char = input[index];
      if (quote) {
        output += char;
        if (char === quote) {
          if (input[index + 1] === quote) output += input[++index]; else quote = null;
        }
      } else if (["'", '"', "`", "["].includes(char)) { quote = char === "[" ? "]" : char; output += char; }
      else if (!/\s/.test(char)) output += char;
    }
    if (quote) fail("capture-tracking-incomplete");
    return output.replace(/;$/, "");
  };
  const expected = new Set(plan.statements.map((item) => normalize(item.sql)));
  if (!state || state.status !== "open" || state.released_at !== null || !integer(state.revision)
    || guards.results.length !== expected.size || guards.results.some((row) => !expected.has(normalize(row.sql)))) fail("capture-tracking-incomplete");
  return { schemaHash: plan.schemaHash, revision: state.revision };
}
export async function captureStorageCapacityInputs(env: Env, due: StorageCapacityRenewalDue, now = new Date()): Promise<StorageCapacityCapture> {
  if (!due.needed || !due.runId || !due.sessionDate || !due.populationHash || env.EOD_CODE_REVISION !== due.codeRevision) fail("current-publication-required");
  const [market, history, inputClock, current] = await Promise.all([
    captureOpenStorageDatabase(env.MARKET_DATA_DB!), captureOpenStorageDatabase(env.MARKET_HISTORY_DB!),
    env.MARKET_DATA_DB!.prepare("SELECT revision FROM eod_input_clock WHERE id='default'").first<number>("revision"),
    loadEodInputs(env, due.sessionDate),
  ]);
  if (!integer(inputClock) || await eodHash(sorted(current.tickers)) !== due.populationHash) fail("population-changed-during-capture");
  return { version: 1, market, history, inputClock, populationHash: due.populationHash, runId: due.runId,
    sessionDate: due.sessionDate, codeRevision: due.codeRevision, capturedAt: now.toISOString() };
}
export function assertStorageCapacityCapture(expected: StorageCapacityCapture, actual: StorageCapacityCapture): void {
  const { capturedAt: _left, ...left } = expected, { capturedAt: _right, ...right } = actual;
  if (JSON.stringify(left) !== JSON.stringify(right)) fail("inputs-changed-during-capture");
}
/** Cheap periodic check; complete schema/current population reads are reserved
 * for capture/measurement phase boundaries and the final publication CAS. */
export async function assertStorageCapacityRevisions(env: Env, expected: StorageCapacityCapture): Promise<void> {
  const [market, history, inputClock] = await Promise.all([
    env.MARKET_DATA_DB!.prepare("SELECT status,revision,released_at FROM market_storage_fence WHERE id='default'")
      .first<{ status: string; revision: number; released_at: string | null }>(),
    env.MARKET_HISTORY_DB!.prepare("SELECT status,revision,released_at FROM market_storage_fence WHERE id='default'")
      .first<{ status: string; revision: number; released_at: string | null }>(),
    env.MARKET_DATA_DB!.prepare("SELECT revision FROM eod_input_clock WHERE id='default'").first<number>("revision"),
  ]);
  if (!market || !history || market.status !== "open" || history.status !== "open" || market.released_at !== null
    || history.released_at !== null || market.revision !== expected.market.revision || history.revision !== expected.history.revision
    || inputClock !== expected.inputClock) fail("inputs-changed-during-capture");
}

export async function claimStorageCapacityRenewal(ops: D1Database, due: StorageCapacityRenewalDue, now = new Date()): Promise<StorageCapacityRenewalStatus | null> {
  if (!due.needed || !due.previousProofHash || !due.populationHash) fail("not-due");
  const status: StorageCapacityRenewalStatus = { version: 1, codeRevision: due.codeRevision, attemptId: crypto.randomUUID(),
    status: "running", stage: "capture", updatedAt: now.toISOString(), leaseUntil: new Date(now.getTime() + STORAGE_CAPACITY_RENEWAL_LEASE_MS).toISOString(),
    nextAttemptAt: null, error: null, previousProofHash: due.previousProofHash, populationHash: due.populationHash, progress: {} };
  const row = await ops.prepare(`INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES(?,?,?)
    ON CONFLICT(id) DO UPDATE SET evidence_json=excluded.evidence_json,updated_at=excluded.updated_at
    WHERE COALESCE(json_extract(eod_rollout_evidence.evidence_json,'$.leaseUntil'),'')<=?
      AND COALESCE(json_extract(eod_rollout_evidence.evidence_json,'$.nextAttemptAt'),'')<=?
    RETURNING evidence_json`).bind(storageCapacityRenewalKey(due.codeRevision), JSON.stringify(status), now.toISOString(), now.toISOString(), now.toISOString())
    .first<string>("evidence_json");
  return row && object(JSON.parse(row)).attemptId === status.attemptId ? status : null;
}
export async function progressStorageCapacityRenewal(ops: D1Database, status: StorageCapacityRenewalStatus, stage: string,
  progress: Record<string, number | string> = {}, now = new Date()): Promise<void> {
  if (!/^[a-z-]{1,40}$/.test(stage) || JSON.stringify(progress).length > 4_000) fail("progress-invalid");
  const next = { ...status, stage, progress, updatedAt: now.toISOString() };
  const row = await ops.prepare(`UPDATE eod_rollout_evidence SET evidence_json=?,updated_at=? WHERE id=?
    AND json_extract(evidence_json,'$.attemptId')=? AND json_extract(evidence_json,'$.status')='running'
    AND json_extract(evidence_json,'$.leaseUntil')>? RETURNING id`)
    .bind(JSON.stringify(next), now.toISOString(), storageCapacityRenewalKey(status.codeRevision), status.attemptId, now.toISOString()).first();
  if (!row) fail("lease-lost");
  Object.assign(status, next);
}
export async function finishStorageCapacityRenewal(ops: D1Database, status: StorageCapacityRenewalStatus, result: { proofHash: string } | { error: string; quota: boolean }, now = new Date()): Promise<void> {
  const error = "error" in result ? result.error : null;
  const nextAttemptAt = !error ? null : "quota" in result && result.quota
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5)).toISOString()
    : new Date(now.getTime() + 90 * 60_000).toISOString();
  const next: StorageCapacityRenewalStatus = { ...status, status: error ? "failed" : "completed", leaseUntil: null,
    error: error && /^[a-z0-9-]{1,150}$/.test(error) ? error : error ? "measurement-failed" : null,
    nextAttemptAt, updatedAt: now.toISOString(), progress: "proofHash" in result ? { proofHash: result.proofHash } : status.progress };
  const saved = await ops.prepare(`UPDATE eod_rollout_evidence SET evidence_json=?,updated_at=? WHERE id=?
    AND json_extract(evidence_json,'$.attemptId')=? RETURNING id`)
    .bind(JSON.stringify(next), now.toISOString(), storageCapacityRenewalKey(status.codeRevision), status.attemptId).first();
  if (!saved) fail("lease-lost");
}
export async function loadStorageCapacityRenewalStatus(env: Env, now = new Date()): Promise<StorageCapacityRenewalStatus | null> {
  if (!env.OPS_DB || !env.EOD_CODE_REVISION) return null;
  const row = await read<StorageCapacityRenewalStatus>(env.OPS_DB, storageCapacityRenewalKey(env.EOD_CODE_REVISION));
  if (!row) return null;
  const date = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
  if (row.version !== 1 || row.codeRevision !== env.EOD_CODE_REVISION || !date(row.updatedAt)
    || !["running", "failed", "completed"].includes(row.status) || !/^[a-z-]{1,40}$/.test(row.stage)
    || (row.error !== null && (typeof row.error !== "string" || !/^[a-z0-9-]{1,150}$/.test(row.error)))
    || (row.nextAttemptAt !== null && !date(row.nextAttemptAt)) || (row.leaseUntil !== null && !date(row.leaseUntil))
    || !digest(row.previousProofHash) || !digest(row.populationHash)) fail("status-invalid");
  if (row.status === "running" && (!row.leaseUntil || Date.parse(row.leaseUntil) <= now.getTime())) {
    return { ...row, status: "failed", error: "attempt-interrupted", leaseUntil: null, nextAttemptAt: now.toISOString() };
  }
  return row;
}

/** New measurements can renew capacity, never approve a new runtime. Original
 * migration/code-reader evidence remains immutable; this proof adds a fresh,
 * independently flattened full-population reader comparison and physical model. */
export async function storeRenewedStorageHistoryMaintenanceApproval(env: Env, input: {
  previous: StorageHistoryMaintenanceApproval; status: StorageCapacityRenewalStatus; capture: StorageCapacityCapture;
  consumerCapture: StorageAcceptanceCapture; consumers: StorageConsumerEvidence; publications: StoragePublicationEvidence;
  capacity: Awaited<ReturnType<typeof validateStorageCapacityAnalysis>>; analysis: unknown; tickers: string[];
  assertCapture: () => Promise<void>; now?: Date;
}): Promise<StorageHistoryMaintenanceApproval> {
  const now = input.now ?? new Date(), previous = input.previous, tickers = sorted(input.tickers), report = object(input.analysis);
  if (!env.OPS_DB || !env.MARKET_DATA_DB || env.EOD_RUNNER_MODE !== "active" || env.EOD_CODE_REVISION !== input.status.codeRevision) fail("active-bindings-required");
  // An absent active approval must not call the candidate-approval branch.
  if (!await read(env.OPS_DB, `active:${env.EOD_CODE_REVISION}`)) fail("approved-code-required");
  await assertEodCutover(env, env.EOD_CODE_REVISION);
  const current = await loadStorageHistoryMaintenanceApproval(env, env.EOD_CODE_REVISION);
  if (!current || current.proofHash !== previous.proofHash || previous.proofHash !== input.status.previousProofHash) fail("previous-proof-changed");
  const identity = input.publications.identity;
  const migration = await loadStorageMigration(env.OPS_DB, previous.proof.identity.id);
  const activation = await read<Record<string, unknown>>(env.OPS_DB, "monitoring:public-activation");
  if (!migration || migration.status !== "completed" || activation?.marketDatabaseId !== identity.targetDatabaseId
    || activation?.codeRevision !== storageExecutionRevision(migration) || migration.target_database_id !== identity.targetDatabaseId
    || migration.history_database_id !== identity.historyDatabaseId || identity.id !== migration.id
    || identity.sourceDatabaseId !== migration.source_database_id || identity.codeRevision !== env.EOD_CODE_REVISION
    || identity.sessionDate !== input.capture.sessionDate) fail("completed-public-migration-required");
  const { evidenceHash, ...publicationBody } = input.publications;
  if (await eodHash(publicationBody) !== evidenceHash || input.publications.inputClock !== input.capture.inputClock
    || input.publications.runId !== input.capture.runId || input.publications.sessionDate !== input.capture.sessionDate
    || await eodHash(tickers) !== input.capture.populationHash || input.capture.populationHash !== input.publications.tickerHash
    || input.status.populationHash !== input.capture.populationHash || input.capture.codeRevision !== env.EOD_CODE_REVISION
    || input.publications.tickerCount !== tickers.length || input.publications.scopes.length !== 7
    || [...EOD_PUBLICATION_SCOPES,"history:catalog"].some((scope) => input.publications.scopes.filter((row) => row.scope === scope).length !== 1)) fail("publication-capture-mismatch");
  await validateStorageConsumerEvidence(input.consumers, input.consumerCapture, tickers);
  if (input.consumerCapture.captureHash !== await eodHash(input.capture)
    || await eodHash(input.consumerCapture.identity) !== await eodHash(identity)
    || await eodHash(input.consumerCapture.sourceCapture) !== await eodHash(input.capture.market)
    || await eodHash(input.consumerCapture.targetCapture) !== await eodHash(input.capture.market)
    || await eodHash(input.consumerCapture.historyCapture) !== await eodHash(input.capture.history)) fail("consumer-capture-mismatch");
  const age = (value: string) => now.getTime() - Date.parse(value);
  if ([input.capture.capturedAt, input.capacity.measuredAt, input.consumers.completedAt, String(report.measuredAt)]
    .some((value) => !Number.isFinite(age(value)) || age(value) < 0 || age(value) > 86_400_000)) fail("measurement-expired");
  const model = (Array.isArray(report.retentionModels) ? report.retentionModels.map(object) : []).find((row) => row.hotSessions === input.capacity.hotSessions);
  const database = object(model?.database), priceBytes = database.priceTableAndIndexBytes, physicalBytes = database.physicalBytes;
  const archiveContext=await validateStorageCurrentArchiveReport(report,{codeRevision:identity.codeRevision,tickerHash:input.capture.populationHash,sourceSnapshotHash:String(object(report.source).snapshotSha256),sessionDate:input.capture.sessionDate});
  if(archiveContext)await authenticateStorageRenewalArchiveContext(env.OPS_DB,archiveContext,{previousProofHash:previous.proofHash,attemptId:input.status.attemptId,capture:input.capture});
  if (!model || input.capacity.hotSessions !== previous.proof.model.hotSessions || input.capacity.hotSessions !== 90
    || await eodHash(report) !== input.capacity.analysisHash || !integer(priceBytes) || priceBytes <= 0
    || !integer(physicalBytes) || physicalBytes < priceBytes || !integer(model.sweepHeadroomSessions) || model.sweepHeadroomSessions < 10
    || model.sharedTickers !== tickers.length || !storageFallbackModelValid(report, model, tickers.length)
    || model.modeledSipRows !== tickers.length * (input.capacity.hotSessions + model.sweepHeadroomSessions)
    || !digest(object(report.source).snapshotSha256) || model.projectedBytes !== input.capacity.projectedMarketBytes
    || input.capacity.projectedMarketBytes !== physicalBytes + input.capacity.publicationGrowthReserveBytes
    || !integer(input.capacity.projectedMarketBytes) || input.capacity.projectedMarketBytes <= 0 || input.capacity.projectedMarketBytes >= 350_000_000
    || !integer(input.capacity.projectedHistoryBytes) || input.capacity.projectedHistoryBytes <= 0 || input.capacity.projectedHistoryBytes >= 350_000_000
    || !integer(input.capacity.forecastSessions) || input.capacity.forecastSessions < 20) fail("measured-layout-required");
  const future = await env.MARKET_DATA_DB.prepare(`SELECT session_date FROM market_calendar_sessions WHERE session_date>? ORDER BY session_date LIMIT ?`)
    .bind(input.publications.sessionDate, input.capacity.forecastSessions).all<{ session_date: string }>();
  if (future.results.length !== input.capacity.forecastSessions) fail("forecast-calendar-incomplete");
  if(archiveContext && JSON.stringify(future.results.map(row=>row.session_date))!==JSON.stringify(archiveContext.forecastCalendarDates.slice(0,input.capacity.forecastSessions)))fail("forecast-calendar-mismatch");
  const lastCoveredSession = future.results.at(-1)!.session_date;
  const proof = { identity, tickerHash: input.capture.populationHash, tickers, publicationRunId: input.publications.runId,
    consumerProofHash: input.consumers.evidenceHash, readers: { contractVersion: input.consumers.readerContractVersion,
      checkedAt: input.consumers.completedAt, consumers: [...MARKET_HISTORY_REQUIRED_CONSUMERS], parityPassed: true, codeRevision: identity.codeRevision },
    capacity: input.capacity, model: { measuredAt: String(report.measuredAt), sourceSnapshotHash: String(object(report.source).snapshotSha256),
      priceTableAndIndexBytes: priceBytes, modeledPriceRows: Number(model.modeledSipRows) + Number(model.modeledFallbackRows),
      fullLayoutBytes: physicalBytes, hotSessions: input.capacity.hotSessions, sweepHeadroomSessions: model.sweepHeadroomSessions,
      ...(archiveContext ? {currentArchiveForecast:storageAcceptedArchiveForecast(report,archiveContext,input.capacity.projectedHistoryBytes)} : {}),
      ...(model.fallbackStorage === EOD_YAHOO_ARCHIVE_LAYOUT ? { fallbackStorage: EOD_YAHOO_ARCHIVE_LAYOUT } : {}) },
    horizon: { anchorSession: input.publications.sessionDate, lastCoveredSession, expiresAt: new Date(Date.parse(`${lastCoveredSession}T00:00:00Z`) + 86_400_000).toISOString(), sessions: input.capacity.forecastSessions },
    renewal: { version: 1, attemptId: input.status.attemptId, previousProofHash: previous.proofHash, previousReaders: previous.proof.readers,
      previousConsumerProofHash: previous.proof.consumerProofHash, capture: input.capture, consumerProof: input.consumers,
      measurementMethod: "captured-sqlite-full-population-v1" } };
  const proofHash = await eodHash(proof);
  const approved: StorageHistoryMaintenanceApproval = { version: 1, kind: "storage-layout-v1", codeRevision: identity.codeRevision,
    approvedAt: now.toISOString(), proofHash, proof };
  await input.assertCapture();
  const stored = await read(env.OPS_DB, `history-storage-proof:${proofHash}`);
  if (stored && await eodHash(stored) !== await eodHash(approved)) fail("immutable-proof-conflict");
  await env.OPS_DB.prepare(`INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING`)
    .bind(`history-storage-proof:${proofHash}`, JSON.stringify(approved), now.toISOString()).run();
  if (await eodHash(await read(env.OPS_DB, `history-storage-proof:${proofHash}`)) !== await eodHash(approved)) fail("immutable-proof-readback");
  // The direct pointer may be absent after a config-only bridge. Only the
  // current attempt and previous proof can create/advance it, in one Ops CAS.
  const promoted = await env.OPS_DB.prepare(`INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at)
    SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM eod_rollout_evidence WHERE id=?
      AND json_extract(evidence_json,'$.attemptId')=? AND json_extract(evidence_json,'$.status')='running'
      AND json_extract(evidence_json,'$.leaseUntil')>?)
    ON CONFLICT(id) DO UPDATE SET evidence_json=excluded.evidence_json,updated_at=excluded.updated_at
    WHERE json_extract(eod_rollout_evidence.evidence_json,'$.proofHash')=? RETURNING id`)
    .bind(`history-storage-approval:${identity.codeRevision}`, JSON.stringify(approved), now.toISOString(),
      storageCapacityRenewalKey(identity.codeRevision), input.status.attemptId, now.toISOString(), previous.proofHash).first();
  if (!promoted) fail("approval-cas-conflict");
  return approved;
}
