import { z } from "zod";
import { EOD_PUBLICATION_SCOPES, expectedEodSession } from "./eod-coordinator";
import { EOD_METRICS_VERSION } from "./eod-metrics";
import { assertHistoryPruneEvidence } from "./eod-history-maintenance";
import { eodHash } from "./eod-publication-service";
import { decodeEodPayload, type EodStoredPayload } from "./eod-publication-codec";
import { EOD_CATALOG_METHODOLOGY_VERSION, EOD_CATALOG_SCOPE } from "./eod-catalog-service";
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
  usageDate: date, eodRowsRead: count.max(2_500_000), eodRowsWritten: count.max(50_000),
  accountRowsRead: count.max(4_500_000), accountRowsWritten: count.max(90_000),
  httpCpuMs: z.number().finite().nonnegative(), coordinatorCpuMs: z.number().finite().nonnegative(),
  queriesPerInvocation: count, queryDurationMs: z.number().finite().nonnegative(),
  source: z.string().trim().min(1),
}).strict();
const limitsSchema = z.object({
  httpCpuMs: z.number().positive().max(10), coordinatorCpuMs: z.number().positive().max(10),
  queriesPerInvocation: positiveCount.max(50), queryDurationMs: z.number().positive().max(30_000),
}).strict();
const capacitySchema = z.object({
  measuredAt: timestamp, marketDatabaseBytes: positiveCount, priceTableAndIndexBytes: positiveCount,
  priceRows: positiveCount, retainedPriceRows: positiveCount, archiveDatabaseBytes: count, additionalArchiveBytes: count,
}).strict();
const readersSchema = z.object({
  contractVersion: positiveCount, checkedAt: timestamp, consumers: z.array(z.string()), parityPassed: z.literal(true),
}).strict();
export const eodCutoverEvidenceSchema = z.object({
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
function assertMeasurements(measurements: z.infer<typeof measurementsSchema>, limits: z.infer<typeof limitsSchema>): void {
  if (measurements.httpCpuMs > limits.httpCpuMs || measurements.coordinatorCpuMs > limits.coordinatorCpuMs
    || measurements.queriesPerInvocation > limits.queriesPerInvocation || measurements.queryDurationMs >= limits.queryDurationMs
    || measurements.eodRowsRead > measurements.accountRowsRead || measurements.eodRowsWritten > measurements.accountRowsWritten) fail("measured-limits-exceeded");
}
function assertScopes(scopes: Array<z.infer<typeof scopeSchema>>, sessionDate: string): void {
  if (new Set(scopes.map((row) => row.scope)).size !== 6 || new Set(scopes.map((row) => row.publicationId)).size !== 6
    || scopes.some((row) => row.sessionDate !== sessionDate)) fail("scope-set-incomplete");
}

/** Validates measured evidence; it does not collect or invent production measurements. */
export function validateEodCutoverEvidence(input: unknown, codeRevision: string, now = new Date()): EodCutoverEvidence {
  const parsed = eodCutoverEvidenceSchema.safeParse(input);
  if (!parsed.success) fail(`invalid-schema:${parsed.error.issues[0]?.path.join(".") ?? "root"}`);
  const proof = parsed.data;
  assertIdentity(codeRevision, proof.codeRevision);
  const age = now.getTime() - Date.parse(proof.measuredAt);
  if (age < 0 || age > 86_400_000) fail("measurement-expired");
  assertMeasurements(proof.measurements, proof.limits);
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
  const [eod, account] = await Promise.all([
    env.OPS_DB!.prepare("SELECT rows_read,rows_written FROM eod_usage WHERE usage_date=?").bind(measurements.usageDate).first<{rows_read:number;rows_written:number}>(),
    env.OPS_DB!.prepare("SELECT rows_read,rows_written,error FROM eod_account_usage WHERE usage_date=?").bind(measurements.usageDate).first<{rows_read:number;rows_written:number;error:string|null}>(),
  ]);
  // Counters can rise after the measurement (including guard bookkeeping).
  // They must still fit the ceilings; they are not an immutable telemetry sample.
  if (!eod || !account || account.error || eod.rows_read > 2_500_000 || eod.rows_written > 50_000
    || account.rows_read > 4_500_000 || account.rows_written > 90_000) fail("recorded-usage-mismatch");
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
export async function assertEodCutover(env: Env, codeRevision: string): Promise<EodCutoverEvidence | null> {
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
    return parsed.data.proof;
  };
  // Approval is durable for this exact revision. Live admission still checks
  // current account usage/capacity for every run; measurements are not redated.
  const approved = await readApproval();
  if (approved) return approved;
  const row = await env.OPS_DB.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id='cutover'").first<{evidence_json:string}>();
  if (!row) fail("required");
  const proof = validateEodCutoverEvidence(parseObject(row.evidence_json), codeRevision);
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

const retirementSchema = z.object({
  version: z.literal(1), codeRevision: z.string(), methodologyVersion: z.literal(EOD_METRICS_VERSION),
  sessions: z.array(z.object({ sessionDate: date, runId: z.string().min(1), deadlineAt: timestamp,
    publishedAt: timestamp, scopes: z.array(scopeSchema).length(6), measurements: measurementsSchema, limits: limitsSchema }).strict()).length(10),
}).strict();
export function validateEodRetirementEvidence(input: unknown, codeRevision: string, exchangeSessions: string[]) {
  const parsed = retirementSchema.safeParse(input);
  if (!parsed.success) fail("retirement-schema");
  const proof = parsed.data;
  assertIdentity(codeRevision, proof.codeRevision);
  const expected = [...new Set(exchangeSessions)].sort().slice(-10);
  const actual = proof.sessions.map((session) => session.sessionDate).sort();
  if (expected.length !== 10 || actual.some((session, index) => session !== expected[index])) fail("retirement-ten-consecutive-sessions");
  for (const session of proof.sessions) {
    assertMeasurements(session.measurements, session.limits);
    assertScopes(session.scopes, session.sessionDate);
    if (Date.parse(session.publishedAt) > Date.parse(session.deadlineAt)) fail("retirement-deadline-missed");
  }
  return proof;
}

/** Separate retirement check: ten sessions are not an initial active-writer prerequisite. */
export async function assertEodRetirement(env: Env, codeRevision: string): Promise<void> {
  if (env.EOD_RUNNER_MODE !== "active") fail("retirement-active-mode-required");
  await assertEodCutover(env, codeRevision);
  const row = await env.OPS_DB!.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id='retirement'").first<{evidence_json:string}>();
  if (!row) fail("retirement-required");
  const expected = await expectedEodSession(env);
  const calendar = await env.MARKET_DATA_DB!.prepare("SELECT session_date FROM market_calendar_sessions WHERE session_date<=? ORDER BY session_date DESC LIMIT 10")
    .bind(expected).all<{session_date:string}>();
  const proof = validateEodRetirementEvidence(parseObject(row.evidence_json), codeRevision, calendar.results.map((value) => value.session_date));
  for (const session of proof.sessions) {
    const run = await env.OPS_DB!.prepare("SELECT mode,purpose,status,session_date,deadline_at,deadline_missed FROM eod_runs WHERE id=?")
      .bind(session.runId).first<StoredRun>();
    if (!run || run.mode !== "active" || run.purpose !== "daily" || run.status !== "completed" || run.session_date !== session.sessionDate
      || run.deadline_missed || run.deadline_at !== session.deadlineAt) fail("retirement-run-mismatch");
    const publications = await checkPublications(env, session.scopes, false);
    for (const publication of publications.values()) if (!publication.accepted_at
      || Date.parse(publication.accepted_at) > Date.parse(session.deadlineAt)
      || Date.parse(publication.accepted_at) > Date.parse(session.publishedAt)) fail("retirement-publication-late");
    await checkRecordedUsage(env, session.measurements);
  }
}
