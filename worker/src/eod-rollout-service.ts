import { assertEodRollingBudget, resolveEodBudgetProfile, type EodBudgetProfile } from "./eod-budget-profile";
import { z } from "zod";
import { expectedEodSession } from "./eod-coordinator";
import { EOD_PUBLICATION_SCOPES } from "./eod-publication-scopes";
import { EOD_METRICS_VERSION } from "./eod-metrics";
import { assertHistoryPruneEvidence } from "./eod-history-maintenance";
import { eodHash } from "./eod-publication-service";
import { decodeEodPayload, type EodStoredPayload } from "./eod-publication-codec";
import { EOD_CATALOG_METHODOLOGY_VERSION, EOD_CATALOG_SCOPE } from "./eod-catalog-service";
import { collectEodRolloutMonitoring } from "./eod-rollout-monitor";
import { EOD_RETIREMENT_POLICY_VERSION, EOD_RETIREMENT_REQUIRED_SESSIONS } from "./eod-retirement-policy";
import { isEodCurrentHealthReady } from "./eod-current-health";
import type { Env } from "./types";

const universeIds = ["sp500-core", "nasdaq-core", "nyse-core", "russell2000-core", "overall-market-proxy"] as const;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const stamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value;
});
const timestamp = z.string().datetime({ offset: true });
const count = z.number().int().nonnegative().safe();
const positiveCount = count.positive();
const scopeSchema = z.object({ scope: z.enum(EOD_PUBLICATION_SCOPES), publicationId: z.string().min(1), sessionDate: date }).strict();
const measurementsSchema = z.object({
  usageDate: date, eodRowsRead: count, eodRowsWritten: count,
  accountRowsRead: count, accountRowsWritten: count,
  httpCpuMs: z.number().finite().nonnegative(), coordinatorCpuMs: z.number().finite().nonnegative(),
  queriesPerInvocation: count, queryDurationMs: z.number().finite().nonnegative(),
  source: z.string().trim().min(1),
}).strict();
const limitsSchema = z.object({
  httpCpuMs: z.number().positive().max(1_000), coordinatorCpuMs: z.number().positive().max(1_000),
  queriesPerInvocation: positiveCount.max(300), queryDurationMs: z.number().positive().max(30_000),
}).strict();
const capacitySchema = z.object({
  measuredAt: timestamp, marketDatabaseBytes: positiveCount, priceTableAndIndexBytes: positiveCount,
  priceRows: positiveCount, retainedPriceRows: positiveCount, archiveDatabaseBytes: count, additionalArchiveBytes: count,
}).strict();
const readersSchema = z.object({
  contractVersion: positiveCount, checkedAt: timestamp, consumers: z.array(z.string()), parityPassed: z.literal(true),
}).strict();
export const eodCutoverEvidenceSchema = z.object({
  budgetProfile: z.enum(["free", "paid"]).optional(),
  version: z.literal(1), codeRevision: z.string().regex(/^[a-f0-9]{40}$/i), methodologyVersion: z.literal(EOD_METRICS_VERSION),
  measuredAt: timestamp, runId: z.string().min(1), sessionDate: date,
  sharedTickers: z.object({ count: positiveCount, processed: positiveCount }).strict(),
  fullUniverseCounts: z.array(z.object({
    universeId: z.enum(universeIds), memberCount: positiveCount, attemptedCount: positiveCount, observedCount: positiveCount,
  }).strict()).length(5),
  scopes: z.array(scopeSchema).length(6), measurements: measurementsSchema, limits: limitsSchema,
  capacity: capacitySchema, readers: readersSchema,
  retention: z.object({ hotSessions: z.union([z.literal(260), z.literal(90)]), sweepHeadroomSessions: positiveCount.min(10) }).strict(),
}).strict();
export type EodCutoverEvidence = z.infer<typeof eodCutoverEvidenceSchema>;
const approvalSchema = z.object({
  version: z.literal(1), codeRevision: z.string().regex(/^[a-f0-9]{40}$/i), methodologyVersion: z.literal(EOD_METRICS_VERSION),
  approvedAt: timestamp, proofHash: z.string().regex(/^[a-f0-9]{64}$/), proof: eodCutoverEvidenceSchema,
}).strict();

function fail(reason: string): never { throw new Error(`eod-cutover-proof-${reason}`); }
function assertIdentity(codeRevision: string, actual: string): void {
  if (!/^[a-f0-9]{40}$/i.test(codeRevision) || actual !== codeRevision) fail("code-revision-mismatch");
}
function assertMeasurements(measurements: z.infer<typeof measurementsSchema>, limits: z.infer<typeof limitsSchema>, profile: EodBudgetProfile): void {
  if (measurements.eodRowsRead > profile.eodDaily.reads || measurements.eodRowsWritten > profile.eodDaily.writes
    || measurements.accountRowsRead > profile.accountDaily.reads || measurements.accountRowsWritten > profile.accountDaily.writes
    || limits.httpCpuMs > profile.runtime.httpCpuMs || limits.coordinatorCpuMs > profile.runtime.coordinatorCpuMs
    || limits.queriesPerInvocation > profile.runtime.queriesPerInvocation || limits.queryDurationMs > profile.runtime.queryDurationMs) fail("profile-limits-exceeded");
  if (measurements.httpCpuMs > limits.httpCpuMs || measurements.coordinatorCpuMs > limits.coordinatorCpuMs
    || measurements.queriesPerInvocation > limits.queriesPerInvocation || measurements.queryDurationMs >= limits.queryDurationMs
    || measurements.eodRowsRead > measurements.accountRowsRead || measurements.eodRowsWritten > measurements.accountRowsWritten) fail("measured-limits-exceeded");
}
function assertScopes(scopes: Array<z.infer<typeof scopeSchema>>, sessionDate: string): void {
  if (new Set(scopes.map((row) => row.scope)).size !== 6 || new Set(scopes.map((row) => row.publicationId)).size !== 6
    || scopes.some((row) => row.sessionDate !== sessionDate)) fail("scope-set-incomplete");
}

/** Validates measured evidence; it does not collect or invent production measurements. */
export function validateEodCutoverEvidence(input: unknown, codeRevision: string, now = new Date(), expectedProfile?: string): EodCutoverEvidence {
  const parsed = eodCutoverEvidenceSchema.safeParse(input);
  if (!parsed.success) fail(`invalid-schema:${parsed.error.issues[0]?.path.join(".") ?? "root"}`);
  const proof = parsed.data;
  const profile = resolveEodBudgetProfile(proof.budgetProfile);
  if (expectedProfile !== undefined && profile.name !== resolveEodBudgetProfile(expectedProfile).name) fail("budget-profile-mismatch");
  assertIdentity(codeRevision, proof.codeRevision);
  const age = now.getTime() - Date.parse(proof.measuredAt);
  if (age < 0 || age > 86_400_000) fail("measurement-expired");
  assertMeasurements(proof.measurements, proof.limits, profile);
  assertScopes(proof.scopes, proof.sessionDate);
  if (proof.sharedTickers.count !== proof.sharedTickers.processed
    || new Set(proof.fullUniverseCounts.map((row) => row.universeId)).size !== 5) fail("universe-set-incomplete");
  for (const row of proof.fullUniverseCounts) {
    const threshold = row.universeId === "sp500-core" ? 0.98 : 0.95;
    if (row.attemptedCount !== row.memberCount || row.observedCount > row.memberCount
      || row.observedCount / row.memberCount < threshold) fail("universe-coverage");
  }
  const minimumRetainedRows = proof.sharedTickers.count * (proof.retention.hotSessions + proof.retention.sweepHeadroomSessions);
  if (proof.capacity.retainedPriceRows < minimumRetainedRows) fail("sweep-capacity-headroom");
  assertHistoryPruneEvidence(proof.capacity, proof.readers, now);
  return proof;
}

type StoredRun = { id: string; session_date: string; mode: string; purpose: string; status: string; input_json: string; progress_json: string; completed_at: string | null; completed_input_clock?:number|null; deadline_at?: string | null; deadline_missed?: number };
type StoredPublication = EodStoredPayload & { id: string; scope: string; session_date: string; status: string; methodology_version: string; payload_checksum: string | null; accepted_at: string | null; decoded?: Record<string, unknown> };
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function parseObject(value: string): Record<string, unknown> { try { return object(JSON.parse(value)); } catch { return fail("invalid-stored-json"); } }
function strings(value: unknown): string[] { return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : []; }

async function checkPublications(env: Env, scopes: EodCutoverEvidence["scopes"], allowCandidate: boolean): Promise<Map<string, StoredPublication>> {
  const result = await env.MARKET_DATA_DB!.prepare(`SELECT id,scope,session_date,status,methodology_version,payload_json as payload,payload_codec as payloadCodec,payload_base64 as payloadBase64,payload_checksum,accepted_at
    FROM eod_publications WHERE id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(scopes.map((row) => row.publicationId))).all<StoredPublication>();
  const byId = new Map(result.results.map((row) => [row.id, row]));
  for (const scope of scopes) {
    const stored = byId.get(scope.publicationId);
    if (!stored || stored.scope !== scope.scope || stored.session_date !== scope.sessionDate
      || stored.methodology_version !== EOD_METRICS_VERSION
      || (stored.status !== "accepted" && !(allowCandidate && stored.status === "candidate"))) fail("publication-reference");
    stored.decoded = object(await decodeEodPayload(stored));
    if (!stored.payload_checksum || await eodHash(stored.decoded) !== stored.payload_checksum) fail("publication-integrity");
  }
  return byId;
}

async function checkRecordedUsage(env: Env, measurements: z.infer<typeof measurementsSchema>): Promise<void> {
  const profile = resolveEodBudgetProfile(env.EOD_BUDGET_PROFILE);
  const [eod, account] = await Promise.all([
    env.OPS_DB!.prepare("SELECT rows_read,rows_written FROM eod_usage WHERE usage_date=?").bind(measurements.usageDate).first<{rows_read:number;rows_written:number}>(),
    env.OPS_DB!.prepare("SELECT rows_read,rows_written,error FROM eod_account_usage WHERE usage_date=?").bind(measurements.usageDate).first<{rows_read:number;rows_written:number;error:string|null}>(),
  ]);
  // Counters can rise after the measurement (including guard bookkeeping).
  // They must still fit the ceilings; they are not an immutable telemetry sample.
  if (!eod || !account || account.error || eod.rows_read > profile.eodDaily.reads || eod.rows_written > profile.eodDaily.writes
    || account.rows_read > profile.accountDaily.reads || account.rows_written > profile.accountDaily.writes) fail("recorded-usage-mismatch");
  await assertEodRollingBudget(env.OPS_DB!, profile);
}

const catalogRowSchema = z.tuple([
  z.string().min(1), count, date.nullable(), date.nullable(), z.number().finite().positive().nullable(),
  z.number().finite().nonnegative().nullable(), count, z.number().finite().positive().nullable(),
  z.number().finite().nonnegative().nullable(), z.number().finite().nonnegative().nullable(),
]);
const catalogSchema = z.object({
  schemaVersion: z.literal(1), sessionDate: date,
  methodologyVersion: z.literal(EOD_CATALOG_METHODOLOGY_VERSION), rows: z.array(catalogRowSchema),
  compatibility: z.object({ schemaVersion: z.literal(1),
    rows: z.array(z.tuple([z.string().min(1), date.nullable(), z.number().finite().nullable(), date.nullable()])),
  }).strict(),
}).strict();

/** Archive consumers need the full compact SIP catalog as well as the six page
 * scopes. Its reference belongs to completed-run progress, not the page proof. */
async function checkCatalogPublication(env: Env, publicationId: unknown, sessionDate: string,
  tickers: string[], allowCandidate: boolean): Promise<void> {
  if (typeof publicationId !== "string" || !publicationId) fail("catalog-publication-required");
  const stored = await env.MARKET_DATA_DB!.prepare(`SELECT id,scope,session_date,status,methodology_version,
    payload_json as payload,payload_codec as payloadCodec,payload_base64 as payloadBase64,payload_checksum,accepted_at
    FROM eod_publications WHERE id=?`).bind(publicationId).first<StoredPublication>();
  if (!stored || stored.scope !== EOD_CATALOG_SCOPE || stored.session_date !== sessionDate
    || stored.methodology_version !== EOD_CATALOG_METHODOLOGY_VERSION || stored.payloadCodec !== "json"
    || (stored.status !== "accepted" && !(allowCandidate && stored.status === "candidate"))) fail("catalog-publication-reference");
  let decoded: unknown;
  try { decoded = await decodeEodPayload(stored); } catch { fail("catalog-publication-schema"); }
  if (!stored.payload_checksum || await eodHash(decoded) !== stored.payload_checksum) fail("catalog-publication-integrity");
  const parsed = catalogSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.sessionDate !== sessionDate) fail("catalog-publication-schema");
  const rows = parsed.data.rows, expected = new Set(tickers), actual = new Set(rows.map((row) => row[0]));
  if (rows.length !== tickers.length || actual.size !== tickers.length || rows.some((row) => !expected.has(row[0]))) {
    fail("catalog-publication-population");
  }
  const compatibility = parsed.data.compatibility.rows;
  const compatibilityByTicker = new Map(compatibility.map((row) => [row[0], row]));
  if (compatibility.length !== tickers.length || compatibilityByTicker.size !== tickers.length
    || compatibility.some((row) => !expected.has(row[0]))) fail("catalog-compatibility-population");
  for (const row of rows) {
    const [ticker, barCount, firstDate, lastDate, price, avgDollarVolume20d, , previousPrice, volume, avgVolume30d] = row;
    if (barCount === 0
      ? [firstDate, lastDate, price, avgDollarVolume20d, previousPrice, volume, avgVolume30d].some((value) => value !== null)
      : firstDate === null || lastDate === null || firstDate > lastDate || lastDate > sessionDate || price === null
        || (barCount === 1 && previousPrice !== null)) fail("catalog-publication-coverage");
    const [, previousDate, trend5d, windowStart] = compatibilityByTicker.get(ticker)!;
    if ([previousDate, windowStart].some((value) => value !== null
      && (firstDate === null || lastDate === null || value < firstDate || value >= lastDate))
      || (barCount >= 2 ? previousDate === null || previousPrice === null : previousDate !== null)
      || (barCount >= 7 ? trend5d === null || windowStart === null || previousDate === null || windowStart >= previousDate
        : trend5d !== null || windowStart !== null)) fail("catalog-compatibility-coverage");
  }
  // This is one bounded indexed query over the frozen manifest. Zero revisions
  // explicitly represent a security with no previous revision record.
  const stale = await env.MARKET_DATA_DB!.prepare(`SELECT COUNT(*) as count FROM json_each(?) expected
    LEFT JOIN eod_input_revisions actual ON actual.feed='sip' AND actual.ticker=json_extract(expected.value,'$[0]')
    LEFT JOIN eod_adjustment_repairs repair ON repair.feed='sip' AND repair.ticker=json_extract(expected.value,'$[0]')
    WHERE COALESCE(actual.revision,0)<>json_extract(expected.value,'$[6]') OR repair.status='pending'`)
    .bind(JSON.stringify(rows)).first<{count:number}>();
  if (!stale || stale.count !== 0) fail("catalog-publication-inputs-changed");
}

/** The CLI must pass its actual GITHUB_SHA before claiming an active run. Shadow never requires approval. */
export async function assertEodCutover(env: Env, codeRevision: string, candidateProof?: unknown): Promise<EodCutoverEvidence | null> {
  if (env.EOD_RUNNER_MODE !== "active") return null;
  if (!env.OPS_DB || !env.MARKET_DATA_DB || !env.MARKET_HISTORY_DB) fail("bindings-missing");
  assertIdentity(codeRevision, codeRevision);
  const approvalId = `active:${codeRevision}`;
  const readApproval = async (): Promise<EodCutoverEvidence | null> => {
    const stored = await env.OPS_DB!.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?").bind(approvalId).first<{evidence_json:string}>();
    if (!stored) return null;
    const parsed = approvalSchema.safeParse(parseObject(stored.evidence_json));
    if (!parsed.success) fail("invalid-durable-approval");
    assertIdentity(codeRevision, parsed.data.codeRevision);
    assertIdentity(codeRevision, parsed.data.proof.codeRevision);
    if (Date.parse(parsed.data.approvedAt) > Date.now() || await eodHash(parsed.data.proof) !== parsed.data.proofHash) fail("durable-approval-integrity");
    if (resolveEodBudgetProfile(parsed.data.proof.budgetProfile).name !== resolveEodBudgetProfile(env.EOD_BUDGET_PROFILE).name) fail("budget-profile-mismatch");
    assertMeasurements(parsed.data.proof.measurements, parsed.data.proof.limits, resolveEodBudgetProfile(env.EOD_BUDGET_PROFILE));
    return parsed.data.proof;
  };
  // Approval is durable for this exact revision. Live admission still checks
  // current account usage/capacity for every run; measurements are not redated.
  const approved = await readApproval();
  if (approved && candidateProof === undefined) return approved;
  // The operator's narrow configuration-only transition supplies dated source
  // evidence explicitly. It receives every normal live validation below; it
  // cannot overwrite global cutover evidence or bypass checks on replay.
  const row = candidateProof === undefined
    ? await env.OPS_DB.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id='cutover'").first<{evidence_json:string}>() : null;
  if (candidateProof === undefined && !row) fail("required");
  const proof = validateEodCutoverEvidence(candidateProof === undefined ? parseObject(row!.evidence_json) : candidateProof, codeRevision, new Date(), resolveEodBudgetProfile(env.EOD_BUDGET_PROFILE).name);
  if (approved && await eodHash(approved) !== await eodHash(proof)) fail("durable-approval-candidate-conflict");
  const run = await env.OPS_DB.prepare("SELECT id,session_date,mode,purpose,status,input_json,progress_json,completed_at,completed_input_clock FROM eod_runs WHERE id=?")
    .bind(proof.runId).first<StoredRun>();
  if (!run || run.status !== "completed" || run.purpose !== "daily" || run.session_date !== proof.sessionDate || !run.completed_at
    || Date.parse(run.completed_at) > Date.parse(proof.measuredAt)) fail("completed-run-required");
  const inputs = parseObject(run.input_json), progress = parseObject(run.progress_json);
  const tickers = strings(inputs.tickers), published = strings(progress.published);
  if (inputs.methodologyVersion !== EOD_METRICS_VERSION || new Set(tickers).size !== proof.sharedTickers.count
    || tickers.length !== proof.sharedTickers.count || progress.symbols !== proof.sharedTickers.processed
    || proof.scopes.some((scope) => !published.includes(scope.publicationId))) fail("shared-catalog-count-mismatch");
  await checkCatalogPublication(env, progress.catalogPublicationId, proof.sessionDate, tickers, run.mode === "shadow");
  const memberships = Array.isArray(inputs.memberships) ? inputs.memberships.map(object) : [];
  if (memberships.length !== 5) fail("frozen-memberships-missing");
  const publications = await checkPublications(env, proof.scopes, run.mode === "shadow");
  for (const measured of proof.fullUniverseCounts) {
    const membership = memberships.find((value) => value.universeId === measured.universeId);
    const members = strings(membership?.members);
    const scope = proof.scopes.find((value) => value.scope === `breadth:${measured.universeId}`)!;
    const payload = publications.get(scope.publicationId)!.decoded!;
    const metrics = object(payload.metrics), publishedMembership = object(payload.membership);
    if (new Set(members).size !== measured.memberCount || members.length !== measured.memberCount || members.some((ticker) => !tickers.includes(ticker))
      || metrics.totalUniverseMembers !== measured.memberCount || metrics.memberCount !== measured.observedCount
      || publishedMembership.versionId !== membership?.versionId || payload.publishable !== true) fail("frozen-universe-count-mismatch");
  }
  const overviewScope = proof.scopes.find((scope) => scope.scope === "overview:default")!;
  const overview = publications.get(overviewScope.publicationId)!.decoded!;
  if (overview.status !== "ready" || typeof overview.freshnessCurrentCount !== "number" || overview.freshnessCurrentCount < 1) fail("overview-empty");
  await checkRecordedUsage(env, proof.measurements);
  // The catalog tuples track SIP. The completed run's global watermark also
  // proves that Yahoo fallback inputs have not changed since shadow validation.
  const inputClock=await env.MARKET_DATA_DB!.prepare("SELECT revision FROM eod_input_clock WHERE id='default'").first<{revision:number}>();
  if (!Number.isSafeInteger(run.completed_input_clock) || !inputClock
    || inputClock.revision!==run.completed_input_clock) fail("completed-inputs-changed");
  const approvedAt = new Date().toISOString();
  const approval = { version: 1, codeRevision, methodologyVersion: EOD_METRICS_VERSION, approvedAt, proofHash: await eodHash(proof), proof };
  await env.OPS_DB.prepare("INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING")
    .bind(approvalId, JSON.stringify(approval), approvedAt).run();
  const persisted = await readApproval();
  if (!persisted) fail("durable-approval-write-failed");
  return persisted;
}

/** No elapsed observation gate. A current collector result is required;
 * submitting an empty observation array never proves production health. */
export function validateEodRetirementEvidence(input: unknown, codeRevision: string, now = new Date()) {
  const proof = object(input);
  if (proof.version !== 3 || proof.policyVersion !== EOD_RETIREMENT_POLICY_VERSION
    || proof.requiredSessions !== EOD_RETIREMENT_REQUIRED_SESSIONS || proof.methodologyVersion !== EOD_METRICS_VERSION
    || proof.mode !== "active" || proof.eligibleForRetirement !== true || !isEodCurrentHealthReady(proof.currentHealth, now)) {
    fail("retirement-current-health-required");
  }
  assertIdentity(codeRevision, proof.currentHealth.codeRevision ?? "");
  return proof.currentHealth;
}

/** Technical cutover approval, current publication correctness and current
 * quota still apply. Historical delivery/usage records remain diagnostics. */
export async function assertEodRetirement(env: Env, codeRevision: string): Promise<void> {
  if (env.EOD_RUNNER_MODE !== "active") fail("retirement-active-mode-required");
  await assertEodCutover(env, codeRevision);
  const now = new Date();
  validateEodRetirementEvidence(await collectEodRolloutMonitoring(env, now), codeRevision, now);
}
