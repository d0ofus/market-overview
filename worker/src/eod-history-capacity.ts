import { z } from "zod";
import { eodHash } from "./eod-publication-service";
import { assertHistoryPruneEvidence, projectHistoryCapacity,
  type HistoryCapacityEvidence, type HistoryReaderEvidence } from "./eod-history-maintenance";
import type { Env } from "./types";

const CHUNK_SIZE = 80;
const MAX_POPULATION = 10_000;
const MAX_ARCHIVE_TRANSIENT_BYTES = 4 * 1024 * 1024;
const count = z.number().int().nonnegative().safe();
const timestamp = z.string().datetime({ offset: true });
const proofSchema = z.object({
  version: z.literal(1), codeRevision: z.string().regex(/^[a-f0-9]{40}$/i),
  capacity: z.object({ measuredAt: timestamp, marketDatabaseBytes: count.positive(), priceTableAndIndexBytes: count.positive(),
    priceRows: count.positive(), retainedPriceRows: count.positive(), archiveDatabaseBytes: count, additionalArchiveBytes: count }).strict(),
  readers: z.object({ contractVersion: count.positive(), checkedAt: timestamp, consumers: z.array(z.string()), parityPassed: z.literal(true) }).strict(),
  hotSessions: z.union([z.literal(260), z.literal(90)]), sweepHeadroomSessions: count.min(10),
  population: z.object({ feed: z.literal("sip"), tickers: z.array(z.string().regex(/^[A-Z0-9.^/_-]{1,32}$/)).min(1).max(MAX_POPULATION) }).strict(),
}).strict();
export type HistoryMaintenanceProof = z.infer<typeof proofSchema>;
type Approval = { version: 1; approvedAt: string; proofHash: string; proof: HistoryMaintenanceProof };
type RowSample = { ticker: string; revision: number; retainedRows: number; encodedBytes: number };
type SampleState = { version: 1; proofHash: string; populationHash: string; rowsHash: string; rows: RowSample[] };

export class HistoryCapacityMeasurementError extends Error {
  constructor(reason: string) { super(`eod-history-capacity-${reason}`); this.name = "HistoryCapacityMeasurementError"; }
}
function fail(reason: string): never { throw new HistoryCapacityMeasurementError(reason); }
const normalizeTickers = (tickers: string[]) => [...new Set(tickers.map((ticker) => ticker.trim().toUpperCase()))].sort();

async function readJson<T>(db: D1Database, id: string): Promise<T | null> {
  const row = await db.prepare("SELECT evidence_json as evidence FROM eod_rollout_evidence WHERE id=?").bind(id).first<{ evidence: string }>();
  if (!row) return null;
  try { return JSON.parse(row.evidence) as T; } catch { return fail("invalid-stored-json"); }
}
async function writeJson(db: D1Database, id: string, value: unknown, now: Date): Promise<void> {
  await db.prepare(`INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES(?,?,?)
    ON CONFLICT(id) DO UPDATE SET evidence_json=excluded.evidence_json,updated_at=excluded.updated_at`)
    .bind(id, JSON.stringify(value), now.toISOString()).run();
}

/** Initial independent proof is validated once. Automatic measurements never
 * manufacture reader parity or replace its original verification timestamp. */
async function approval(env: Env, tickers: string[], codeRevision: string, now: Date): Promise<Approval> {
  if (!/^[a-f0-9]{40}$/i.test(codeRevision) || env.EOD_CODE_REVISION !== codeRevision) fail("code-revision-mismatch");
  const id = `history-approval:${codeRevision}`;
  const existing = await readJson<Approval>(env.OPS_DB!, id);
  if (existing) {
    const parsed = proofSchema.safeParse(existing.proof);
    if (existing.version !== 1 || !parsed.success || parsed.data.codeRevision !== codeRevision
      || !Number.isFinite(Date.parse(existing.approvedAt)) || Date.parse(existing.approvedAt) > now.getTime()
      || await eodHash(parsed.data) !== existing.proofHash) fail("approval-integrity");
    return existing;
  }
  const submitted = await readJson<unknown>(env.OPS_DB!, "history-capacity");
  const parsed = proofSchema.safeParse(submitted);
  if (!parsed.success || parsed.data.codeRevision !== codeRevision) fail("initial-proof-required");
  const proof = parsed.data;
  if (JSON.stringify(normalizeTickers(proof.population.tickers)) !== JSON.stringify(tickers)
    || proof.population.tickers.length !== tickers.length) fail("initial-population-mismatch");
  if (proof.capacity.retainedPriceRows < tickers.length * (proof.hotSessions + proof.sweepHeadroomSessions)) fail("initial-headroom-incomplete");
  assertHistoryPruneEvidence(proof.capacity, proof.readers, now);
  const value: Approval = { version: 1, approvedAt: now.toISOString(), proofHash: await eodHash(proof), proof };
  // Competing resumptions may only install the same immutable revision approval.
  await env.OPS_DB!.prepare(`INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING`)
    .bind(id, JSON.stringify(value), now.toISOString()).run();
  const stored = await readJson<Approval>(env.OPS_DB!, id);
  if (!stored || stored.proofHash !== value.proofHash || await eodHash(stored.proof) !== value.proofHash) fail("approval-changed-concurrently");
  return stored;
}

/** Indexed per-security counts stop at the retained window. Each query touches
 * at most80×260 hot rows plus80 current row samples/revisions. The admission
 * adapter reserves50k reads for this fixed query, including cursor overhead.
 * No whole-table COUNT, unsupported dbstat scan, or physical-size estimate. */
async function sampleRows(env: Env, tickers: string[], hotSessions: number): Promise<RowSample[]> {
  const result = await env.MARKET_DATA_DB!.prepare(`/* eod-capacity-row-sample */ SELECT CAST(requested.value AS TEXT) as ticker,COALESCE(r.revision,0) as revision,
    (SELECT COUNT(*) FROM (SELECT 1 FROM alpaca_daily_bars b
      WHERE b.feed='sip' AND b.ticker=requested.value ORDER BY date DESC LIMIT ?)) as retainedRows,
    COALESCE((SELECT length(CAST(json_object('ticker',b.ticker,'date',b.date,'feed',b.feed,'o',b.o,'h',b.h,'l',b.l,'c',b.c,
      'volume',b.volume,'reportedVolume',b.reported_volume,'sourceProvider',b.source_provider,'adjustment',b.adjustment,
      'observedAt',b.observed_at,'fetchedAt',b.fetched_at,'reportedVolumeCollectedAt',b.reported_volume_collected_at) AS BLOB)) FROM alpaca_daily_bars b
      WHERE b.feed='sip' AND b.ticker=requested.value ORDER BY date DESC LIMIT 1),0) as encodedBytes
    FROM json_each(?) requested LEFT JOIN eod_input_revisions r ON r.feed='sip' AND r.ticker=requested.value ORDER BY ticker`)
    .bind(hotSessions, JSON.stringify(tickers)).all<RowSample>();
  if (result.results.length !== tickers.length || result.results.some((row) => !tickers.includes(row.ticker)
    || [row.revision, row.retainedRows, row.encodedBytes].some((value) => !Number.isSafeInteger(value) || value < 0)
    || row.retainedRows > hotSessions || (row.retainedRows > 0 && row.encodedBytes === 0))) fail("invalid-row-sample");
  return result.results;
}

async function revisions(env: Env, tickers: string[]): Promise<Map<string, number>> {
  const values = new Map<string, number>();
  for (let offset = 0; offset < tickers.length; offset += 500) {
    const result = await env.MARKET_DATA_DB!.prepare(`SELECT CAST(requested.value AS TEXT) as ticker,COALESCE(r.revision,0) as revision
      FROM json_each(?) requested LEFT JOIN eod_input_revisions r ON r.feed='sip' AND r.ticker=requested.value`)
      .bind(JSON.stringify(tickers.slice(offset, offset + 500))).all<{ ticker: string; revision: number }>();
    for (const row of result.results) values.set(row.ticker, row.revision);
  }
  if (values.size !== tickers.length) fail("revision-sample-incomplete");
  return values;
}

async function physicalBytes(db: D1Database): Promise<number> {
  const result = await db.prepare("SELECT 1 as history_capacity_probe").all<{ history_capacity_probe: number }>();
  const bytes = Number(result.meta?.size_after);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) fail("physical-size-metadata-unavailable");
  return bytes;
}

/** Uses the admitted runner bindings. A quota failure leaves a durable cursor;
 * a new UTC allowance resumes only the unfinished or revision-changed symbols.
 * Physical size is always re-read, even when the completed row cursor is reused. */
export async function refreshHistoryMaintenanceEvidence(env: Env, input: {
  tickers: string[]; codeRevision: string; now?: Date;
}): Promise<{ capacity: HistoryCapacityEvidence; readers: HistoryReaderEvidence; hotSessions: 260 | 90;
  sample: { measuredAt: string; sampledSymbols: number; sampledRows: number; proofHash: string; marketPhysicalBytes: number; archivePhysicalBytes: number } }> {
  if (!env.OPS_DB || !env.MARKET_DATA_DB || !env.MARKET_HISTORY_DB) fail("bindings-required");
  const now = input.now ?? new Date();
  const tickers = normalizeTickers(input.tickers);
  if (!tickers.length || tickers.length > MAX_POPULATION || tickers.some((ticker) => !/^[A-Z0-9.^/_-]{1,32}$/.test(ticker))) fail("population-invalid");
  const measurementId = `history-measurement:${input.codeRevision}`;
  let diagnostics: Record<string, unknown> = {};
  try {
    const approved = await approval(env, tickers, input.codeRevision, now);
    const { proof } = approved;
    const populationHash = await eodHash(tickers);
    const cursorId = `history-sample:${input.codeRevision}`;
    const existing = await readJson<SampleState>(env.OPS_DB, cursorId);
    const validSavedRows = Array.isArray(existing?.rows) && existing.rows.length <= tickers.length
      && new Set(existing.rows.map((row) => row.ticker)).size === existing.rows.length
      && existing.rows.every((row) => tickers.includes(row.ticker)
        && [row.revision, row.retainedRows, row.encodedBytes].every((value) => Number.isSafeInteger(value) && value >= 0)
        && row.retainedRows <= proof.hotSessions && (row.retainedRows === 0 || row.encodedBytes > 0))
      && await eodHash(existing.rows) === existing.rowsHash;
    const state: SampleState = existing?.version === 1 && existing.proofHash === approved.proofHash
      && existing.populationHash === populationHash && validSavedRows
      ? existing : { version: 1, proofHash: approved.proofHash, populationHash, rowsHash: await eodHash([]), rows: [] };
    const currentRevisions = await revisions(env, tickers);
    const reusable = new Map(state.rows.filter((row) => tickers.includes(row.ticker) && row.revision === currentRevisions.get(row.ticker))
      .map((row) => [row.ticker, row]));
    const remaining = tickers.filter((ticker) => !reusable.has(ticker));
    for (let offset = 0; offset < remaining.length; offset += CHUNK_SIZE) {
      for (const row of await sampleRows(env, remaining.slice(offset, offset + CHUNK_SIZE), proof.hotSessions)) reusable.set(row.ticker, row);
      state.rows = Array.from(reusable.values()).sort((a, b) => a.ticker.localeCompare(b.ticker));
      state.rowsHash = await eodHash(state.rows);
      await writeJson(env.OPS_DB, cursorId, state, now);
    }
    const after = await revisions(env, tickers);
    if (state.rows.length !== tickers.length || state.rows.some((row) => row.revision !== after.get(row.ticker))) fail("inputs-changed-during-measurement");
    const marketPhysicalBytes = await physicalBytes(env.MARKET_DATA_DB);
    const archivePhysicalBytes = await physicalBytes(env.MARKET_HISTORY_DB);
    const archiveSample = await env.MARKET_HISTORY_DB.prepare(`SELECT row_count as rows,length(payload_base64) as bytes
      FROM market_history_blocks ORDER BY id LIMIT 64`).all<{ rows: number; bytes: number }>();
    if (archiveSample.results.some((row) => !Number.isSafeInteger(row.rows) || row.rows <= 0 || !Number.isSafeInteger(row.bytes) || row.bytes <= 0)) fail("archive-sample-invalid");
    const sampledRows = state.rows.reduce((sum, row) => sum + row.retainedRows, 0);
    // Both original measured table+index ratio and current maximum encoded row
    // size receive2× headroom. This is a bound for unchanged repository schema,
    // not an assertion that JSON length equals SQLite occupied bytes.
    const priceBytesPerRowBound = Math.ceil(Math.max(proof.capacity.priceTableAndIndexBytes / proof.capacity.priceRows,
      ...state.rows.map((row) => row.encodedBytes)) * 2);
    const remainingHotRows = tickers.length * (proof.hotSessions + proof.sweepHeadroomSessions) - sampledRows;
    const populationGrowth = Math.max(1, tickers.length / proof.population.tickers.length);
    const additionalArchiveBytes = Math.ceil(proof.capacity.additionalArchiveBytes * populationGrowth) + MAX_ARCHIVE_TRANSIENT_BYTES;
    const capacity: HistoryCapacityEvidence = { ...proof.capacity, measuredAt: now.toISOString(), marketDatabaseBytes: marketPhysicalBytes,
      archiveDatabaseBytes: archivePhysicalBytes, additionalArchiveBytes,
      liveProjection: { baselineMeasuredAt: proof.capacity.measuredAt, sampledRows, populationSize: tickers.length, remainingHotRows,
        priceBytesPerRowBound, marketBytes: marketPhysicalBytes + remainingHotRows * priceBytesPerRowBound,
        archiveBytes: archivePhysicalBytes + additionalArchiveBytes } };
    const readers: HistoryReaderEvidence = { ...proof.readers, codeRevision: input.codeRevision };
    const sample = { measuredAt: now.toISOString(), sampledSymbols: state.rows.length, sampledRows, proofHash: approved.proofHash,
      marketPhysicalBytes, archivePhysicalBytes, archiveSampledBlocks: archiveSample.results.length,
      archiveSampledEncodedBytes: archiveSample.results.reduce((total, row) => total + row.bytes, 0) };
    diagnostics = { capacity, readers, sample, projected: projectHistoryCapacity(capacity) };
    assertHistoryPruneEvidence(capacity, readers, now, input.codeRevision);
    await writeJson(env.OPS_DB, measurementId, { status: "ready", ...diagnostics }, now);
    return { capacity, readers, hotSessions: proof.hotSessions, sample };
  } catch (error) {
    // The runner also persists its terminal error through separately reserved
    // control credit when admission itself has exhausted the UTC allowance.
    await writeJson(env.OPS_DB, measurementId, { status: "failed", ...diagnostics, measuredAt: now.toISOString(),
      error: error instanceof Error ? error.message : "measurement-failed" }, now).catch(() => undefined);
    throw error;
  }
}
