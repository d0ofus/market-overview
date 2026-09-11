import { assertEodRollingBudget, resolveEodBudgetProfile, type EodBudgetProfile } from "./eod-budget-profile";
import { EOD_PUBLICATION_SCOPES } from "./eod-coordinator";
import { EOD_METRICS_VERSION } from "./eod-metrics";
import { MARKET_HISTORY_REQUIRED_CONSUMERS } from "./eod-history-maintenance";
import { decodeEodPayload, type EodStoredPayload } from "./eod-publication-codec";
import { eodHash } from "./eod-publication-service";
import { validateEodCutoverEvidence, type EodCutoverEvidence } from "./eod-rollout-service";
import { validateRuntimeEvidence, type RuntimeEvidence, type RuntimeEvidenceIdentity } from "./eod-runtime-evidence";
import { validateStorageCapacityAnalysis, validateStorageConsumerEvidence, verifyStorageAcceptedPublications,
  type StorageAcceptanceCapture, type StorageConsumerEvidence } from "./market-storage-acceptance";
import type { StorageMigrationIdentity } from "./market-storage-control";
import { resolveStorageExecutionIdentity } from "./market-storage-execution";
import type { Env } from "./types";

function fail(reason: string): never { throw new Error(`storage-cutover-builder-${reason}`); }
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function parse(value: string): Record<string, unknown> {
  try { return object(JSON.parse(value)); } catch { return fail("invalid-stored-json"); }
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) fail("stored-membership-invalid");
  return value as string[];
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail("measurement-count-invalid");
  return value;
}

/** Fixed, indexed, current UTC-day reads. Account analytics may lag actual D1
 * queries: the conservative local high-water ledger is retained explicitly.
 * Reservations count against admission but never impersonate billed rows. */
export async function collectStorageCutoverUsage(ops: D1Database, now = new Date(), profile: EodBudgetProfile = resolveEodBudgetProfile()) {
  const usageDate = now.toISOString().slice(0, 10);
  const [eod, account, local] = await Promise.all([
    ops.prepare("SELECT rows_read,rows_written,reserved_reads,reserved_writes FROM eod_usage WHERE usage_date=?")
      .bind(usageDate).first<{ rows_read: number; rows_written: number; reserved_reads: number; reserved_writes: number }>(),
    ops.prepare("SELECT rows_read,rows_written,sampled_at,error FROM eod_account_usage WHERE usage_date=?")
      .bind(usageDate).first<{ rows_read: number; rows_written: number; sampled_at: string; error: string | null }>(),
    ops.prepare("SELECT rows_read,rows_written,updated_at FROM market_data_daily_usage WHERE usage_date=?")
      .bind(usageDate).first<{ rows_read: number; rows_written: number; updated_at: string }>(),
  ]);
  if (!eod || !account || !local || account.error) fail("current-account-and-eod-usage-required");
  const age = now.getTime() - Date.parse(account.sampled_at);
  if (!Number.isFinite(age) || age < 0 || age > 300_000) fail("account-usage-stale");
  const eodRowsRead = count(eod.rows_read), eodRowsWritten = count(eod.rows_written);
  const reservedReads = count(eod.reserved_reads), reservedWrites = count(eod.reserved_writes);
  const accountRowsRead = Math.max(count(account.rows_read), count(local.rows_read));
  const accountRowsWritten = Math.max(count(account.rows_written), count(local.rows_written));
  if (eodRowsRead + reservedReads > profile.eodDaily.reads || eodRowsWritten + reservedWrites > profile.eodDaily.writes
    || accountRowsRead + reservedReads > profile.accountDaily.reads || accountRowsWritten + reservedWrites > profile.accountDaily.writes
    || eodRowsRead > accountRowsRead || eodRowsWritten > accountRowsWritten) fail("quota-headroom-unavailable");
  const rolling31 = await assertEodRollingBudget(ops, profile, now);
  return { measurements: { usageDate, eodRowsRead, eodRowsWritten, accountRowsRead, accountRowsWritten },
    provenance: { budgetProfile: profile.name, rolling31, measuredAt: now.toISOString(), usageDate, eod, account, local, reservedReads, reservedWrites } };
}

/** Read-only assembly, with no caller-provided success flags or metric counts.
 * runtime must be re-collected using authenticated Cloudflare APIs by the CLI;
 * its local checksum alone is not remote attestation. The source fence is the
 * original immutable copy baseline; target/history legitimately change during
 * private bootstrap, whose current accepted publications are checked here. */
export async function buildStorageCutoverEvidence(input: {
  env: Env; identity: StorageMigrationIdentity; runId: string; tickers: readonly string[]; expectedSession: string;
  capture: StorageAcceptanceCapture; consumers: StorageConsumerEvidence; analysis: unknown; publicationGrowth: unknown;
  sourceSnapshotSha256: string; runtime: RuntimeEvidence; runtimeIdentity: RuntimeEvidenceIdentity;
  assertSourceCapture: () => Promise<void>; now?: Date;
}) {
  const now = input.now ?? new Date(), { env } = input;
  const profile = resolveEodBudgetProfile(env.EOD_BUDGET_PROFILE);
  if (!env.MARKET_DATA_DB || !env.MARKET_HISTORY_DB || !env.OPS_DB) fail("bindings-missing");
  const execution = await resolveStorageExecutionIdentity(env.OPS_DB, input.identity, env.EOD_CODE_REVISION ?? "");
  const identity = execution.identity;
  if (env.EOD_CODE_REVISION !== identity.codeRevision || input.runtimeIdentity.codeRevision !== identity.codeRevision
    || input.runtimeIdentity.targetDatabaseId !== identity.targetDatabaseId
    || input.runtimeIdentity.historyDatabaseId !== identity.historyDatabaseId
    || resolveEodBudgetProfile(input.runtimeIdentity.budgetProfile).name !== profile.name
    || await eodHash(input.capture.identity) !== await eodHash(input.identity)) fail("identity-mismatch");
  await input.assertSourceCapture();
  await validateStorageConsumerEvidence(input.consumers, input.capture, input.tickers);
  const runtime = await validateRuntimeEvidence(input.runtime, input.runtimeIdentity);
  const runtimeAge = now.getTime() - runtime.window.to, collectedAge = now.getTime() - Date.parse(runtime.collectedAt);
  if (runtimeAge < 0 || runtimeAge > 86_400_000 || collectedAge < 0 || collectedAge > 300_000) fail("runtime-evidence-expired");
  const publications = await verifyStorageAcceptedPublications({ env, identity, runId: input.runId,
    tickers: input.tickers, expectedSession: input.expectedSession });
  const capacity = await validateStorageCapacityAnalysis({ analysis: input.analysis, publicationGrowth: input.publicationGrowth,
    identity, tickers: input.tickers, sourceSchemaHash: input.capture.sourceCapture.schemaHash,
    sourceSnapshotSha256: input.sourceSnapshotSha256, publications, target: env.MARKET_DATA_DB, history: env.MARKET_HISTORY_DB, now });
  const runQuery = () => env.OPS_DB!.prepare("SELECT input_json,progress_json FROM eod_runs WHERE id=?")
    .bind(input.runId).first<{ input_json: string; progress_json: string }>();
  const run = await runQuery();
  if (!run) fail("completed-run-missing");
  const frozen = parse(run.input_json), progress = parse(run.progress_json), tickers = strings(frozen.tickers);
  const memberships = Array.isArray(frozen.memberships) ? frozen.memberships.map(object) : [];
  if (await eodHash(memberships) !== publications.membershipHash || await eodHash([...tickers].sort()) !== publications.tickerHash
    || progress.symbols !== publications.tickerCount || new Set(tickers).size !== tickers.length) fail("run-inputs-changed");
  const breadth = publications.scopes.filter((scope) => scope.scope.startsWith("breadth:"));
  const rows = await env.MARKET_DATA_DB.prepare(`SELECT id,payload_json AS payload,payload_codec AS payloadCodec,
    payload_base64 AS payloadBase64 FROM eod_publications WHERE id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(breadth.map((scope) => scope.id))).all<EodStoredPayload & { id: string }>();
  const fullUniverseCounts: EodCutoverEvidence["fullUniverseCounts"] = [];
  for (const scope of breadth) {
    const row = rows.results.find((value) => value.id === scope.id);
    if (!row) fail("breadth-publication-missing");
    const payload = object(await decodeEodPayload(row));
    if (await eodHash(payload) !== scope.checksum) fail("breadth-publication-changed");
    const universeId = scope.scope.slice(8) as EodCutoverEvidence["fullUniverseCounts"][number]["universeId"];
    const membership = memberships.find((value) => value.universeId === universeId), members = strings(membership?.members);
    const attemptedCount = members.filter((ticker) => tickers.includes(ticker)).length;
    fullUniverseCounts.push({ universeId, memberCount: members.length, attemptedCount, observedCount: count(object(payload.metrics).memberCount) });
  }
  const report = object(input.analysis), models = Array.isArray(report.retentionModels) ? report.retentionModels.map(object) : [];
  const model = models.find((row) => row.hotSessions === capacity.hotSessions);
  if (!model) fail("measured-model-missing");
  const database = object(model.database), priceBytes = count(database.priceTableAndIndexBytes);
  const priceRows = count(model.modeledSipRows) + count(model.modeledFallbackRows) + count(model.preservedOtherFeedOrNonSharedSeedRows);
  if (!priceBytes || priceBytes > count(database.physicalBytes) || !priceRows) fail("measured-price-layout-missing");
  const liveRefs = await env.MARKET_DATA_DB.prepare(`SELECT scope,publication_id FROM eod_publication_pointers
    WHERE scope IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(publications.scopes.map((row) => row.scope)))
    .all<{ scope: string; publication_id: string }>();
  const clock = await env.MARKET_DATA_DB.prepare("SELECT revision FROM eod_input_clock WHERE id='default'").first<number>("revision");
  if (clock !== publications.inputClock || await eodHash(await runQuery()) !== await eodHash(run)
    || liveRefs.results.length !== 7 || publications.scopes.some((scope) =>
      !liveRefs.results.some((row) => row.scope === scope.scope && row.publication_id === scope.id))) fail("publication-inputs-changed");
  await input.assertSourceCapture();
  // Collect usage last, so completed validation reads are included in admission
  // counters. The surrounding REST adapter accounts for these final reads too.
  const finishedAt = input.now ?? new Date();
  const usage = await collectStorageCutoverUsage(env.OPS_DB, finishedAt, profile);
  const proof = validateEodCutoverEvidence({ version: 1, budgetProfile: profile.name, codeRevision: identity.codeRevision,
    methodologyVersion: EOD_METRICS_VERSION, measuredAt: finishedAt.toISOString(), runId: input.runId,
    sessionDate: input.expectedSession, sharedTickers: { count: tickers.length, processed: count(progress.symbols) }, fullUniverseCounts,
    scopes: EOD_PUBLICATION_SCOPES.map((scope) => ({ scope, publicationId: publications.scopes.find((row) => row.scope === scope)!.id,
      sessionDate: input.expectedSession })), limits: profile.runtime,
    measurements: { ...usage.measurements, ...runtime.measurements,
      source: "Cloudflare raw invocation logs; D1 account analytics and conservative local high-water ledger; real SQLite full dual-feed layout plus measured publication growth" },
    // The legacy rollout schema expects a storage layout. These are the actual
    // measured full-population fixture and its separately measured publication
    // reserve. Equal row counts preserve that exact model without extrapolation.
    // Actual live physical bytes remain separately recorded in provenance.
    capacity: { measuredAt: capacity.measuredAt, marketDatabaseBytes: capacity.projectedMarketBytes,
      priceTableAndIndexBytes: priceBytes, priceRows, retainedPriceRows: priceRows,
      archiveDatabaseBytes: capacity.liveHistoryBytes, additionalArchiveBytes: capacity.projectedHistoryBytes - capacity.liveHistoryBytes },
    readers: { contractVersion: input.consumers.readerContractVersion, checkedAt: input.consumers.completedAt,
      consumers: [...MARKET_HISTORY_REQUIRED_CONSUMERS], parityPassed: true },
    retention: { hotSessions: capacity.hotSessions, sweepHeadroomSessions: count(model.sweepHeadroomSessions) },
  }, identity.codeRevision, finishedAt, profile.name);
  const provenance = { version: 1, identity, captureHash: input.capture.captureHash,
    ...(execution.record ? { storageIdentity: input.identity, executionApprovalHash: execution.record.evidenceHash } : {}),
    sourceSnapshotSha256: input.sourceSnapshotSha256, consumerEvidenceHash: input.consumers.evidenceHash,
    publicationEvidenceHash: publications.evidenceHash, runtimeEvidenceHash: runtime.evidenceHash,
    analysisHash: capacity.analysisHash, publicationGrowthHash: await eodHash(input.publicationGrowth),
    capacity, usage: usage.provenance, proofHash: await eodHash(proof), measuredAt: finishedAt.toISOString() };
  return { proof, provenance, publications, capacity };
}

export type StorageCutoverProofRecord = {
  version: 1; identity: StorageMigrationIdentity; runId: string; sessionDate: string; proofHash: string;
  proof: EodCutoverEvidence; provenanceHash: string;
  provenance: Awaited<ReturnType<typeof buildStorageCutoverEvidence>>["provenance"]; acceptedAt: string;
};

/** Persist the particular storage acceptance independently of active:<SHA>.
 * Code approval is immutable and may predate an interrupted storage acceptance
 * or a newer private session. Each newly measured proof retains its own record;
 * the migration's ready progress identifies which one authorized activation. */
export async function storeStorageCutoverProof(ops: D1Database, input: {
  identity: StorageMigrationIdentity; proof: EodCutoverEvidence;
  provenance: StorageCutoverProofRecord["provenance"]; now?: Date;
}): Promise<{ id: string; record: StorageCutoverProofRecord }> {
  const now = input.now ?? new Date();
  const proof = validateEodCutoverEvidence(input.proof, input.identity.codeRevision, now), proofHash = await eodHash(proof);
  if (input.provenance.proofHash !== proofHash || await eodHash(input.provenance.identity) !== await eodHash(input.identity)) {
    fail("storage-proof-provenance-mismatch");
  }
  const id = `storage-cutover-proof:${proofHash}`;
  const record: StorageCutoverProofRecord = { version: 1, identity: input.identity, runId: proof.runId,
    sessionDate: proof.sessionDate, proofHash, proof, provenanceHash: await eodHash(input.provenance),
    provenance: input.provenance, acceptedAt: now.toISOString() };
  await ops.prepare("INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING")
    .bind(id, JSON.stringify(record), record.acceptedAt).run();
  const stored = await ops.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?").bind(id).first<string>("evidence_json");
  if (!stored) fail("storage-proof-write-unconfirmed");
  const saved = parse(stored) as unknown as StorageCutoverProofRecord;
  if (saved.version !== 1 || saved.proofHash !== proofHash || await eodHash(saved.proof) !== proofHash
    || saved.runId !== proof.runId || saved.sessionDate !== proof.sessionDate
    || await eodHash(saved.identity) !== await eodHash(input.identity)
    || saved.provenanceHash !== record.provenanceHash || await eodHash(saved.provenance) !== saved.provenanceHash
    || !Number.isFinite(Date.parse(saved.acceptedAt)) || Date.parse(saved.acceptedAt) > now.getTime()) {
    fail("stored-proof-integrity-mismatch");
  }
  return { id, record: saved };
}
