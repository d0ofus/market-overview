import { eodHash } from "./eod-publication-service";
import { assertHistoryPruneEvidence, MARKET_HISTORY_REQUIRED_CONSUMERS, type HistoryCapacityEvidence, type HistoryReaderEvidence } from "./eod-history-maintenance";
import { validateStorageConsumerEvidence, type StorageAcceptanceCapture, type StorageConsumerEvidence, type StoragePublicationEvidence,
  type validateStorageCapacityAnalysis } from "./market-storage-acceptance";
import type { Env } from "./types";

type AcceptedCapacity = Awaited<ReturnType<typeof validateStorageCapacityAnalysis>>;
const FEEDS = ["sip", "yahoo-eod"] as const;
type Feed = typeof FEEDS[number];
type Sample = [ticker: string, feed: Feed, revision: number, rows: number];
type Approval = {
  version: 1; kind: "storage-layout-v1"; codeRevision: string; approvedAt: string; proofHash: string;
  proof: { identity: StorageAcceptanceCapture["identity"]; tickerHash: string; tickers: string[]; publicationRunId: string;
    consumerProofHash: string; readers: HistoryReaderEvidence; capacity: AcceptedCapacity;
    model: { measuredAt: string; sourceSnapshotHash: string; priceTableAndIndexBytes: number; modeledPriceRows: number;
      fullLayoutBytes: number; hotSessions: 260 | 90; sweepHeadroomSessions: number };
    horizon: { anchorSession: string; lastCoveredSession: string; expiresAt: string; sessions: number } };
};
export type StorageHistoryCapacityStatus = { status: "unmeasured" | "ready" | "failed" | "expired";
  checkedAt: string | null; error: string | null; hotSessions: 260 | 90; feeds: readonly Feed[];
  forecastSessions: number; forecastAnchorSession: string; forecastLastSession: string; horizonExpiresAt: string;
  forecastRunId: string;
  analysisHash: string; proofHash: string; marketPhysicalBytes: number | null; archivePhysicalBytes: number | null };
function fail(reason: string): never { throw new Error(`eod-history-storage-capacity-${reason}`); }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const population = (values: string[]) => [...values].sort();
async function read<T>(db: D1Database, id: string): Promise<T | null> {
  const value = await db.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?").bind(id).first<string>("evidence_json");
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { return fail("stored-json-invalid"); }
}
async function write(db: D1Database, id: string, value: unknown, now: Date): Promise<void> {
  await db.prepare(`INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES(?,?,?)
    ON CONFLICT(id) DO UPDATE SET evidence_json=excluded.evidence_json,updated_at=excluded.updated_at`)
    .bind(id, JSON.stringify(value), now.toISOString()).run();
}
function cachedStatus(approved: Approval, measurement: Record<string, unknown> | null, now: Date): StorageHistoryCapacityStatus {
  const matching = object(measurement?.sample).proofHash === approved.proofHash, sample = matching ? object(measurement?.sample) : {};
  const expired = now.getTime() >= Date.parse(approved.proof.horizon.expiresAt);
  return { status: expired ? "expired" : matching && measurement?.status === "ready" ? "ready" : measurement?.status === "failed" ? "failed" : "unmeasured",
    checkedAt: typeof sample.measuredAt === "string" ? sample.measuredAt : typeof measurement?.measuredAt === "string" ? measurement.measuredAt : null,
    error: expired ? "forecast-horizon-expired" : typeof measurement?.error === "string" ? measurement.error.slice(0,250) : null,
    hotSessions: approved.proof.model.hotSessions, feeds: FEEDS, forecastSessions: approved.proof.horizon.sessions,
    forecastAnchorSession: approved.proof.horizon.anchorSession, forecastLastSession: approved.proof.horizon.lastCoveredSession,
    forecastRunId: approved.proof.publicationRunId, horizonExpiresAt: approved.proof.horizon.expiresAt,
    analysisHash: approved.proof.capacity.analysisHash, proofHash: approved.proofHash,
    marketPhysicalBytes: integer(sample.marketPhysicalBytes) ? sample.marketPhysicalBytes : null,
    archivePhysicalBytes: integer(sample.archivePhysicalBytes) ? sample.archivePhysicalBytes : null };
}

/** Called by final storage acceptance after live publication/capacity checks.
 * The returned immutable approval replaces no source data and enables no flag.
 * Repeating the same accepted model is idempotent; a new measurement can renew
 * the finite horizon after it independently passes final acceptance again. */
export async function storeStorageHistoryMaintenanceApproval(env: Env, input: {
  capacity: AcceptedCapacity; analysis: unknown; publications: StoragePublicationEvidence;
  consumers: StorageConsumerEvidence; capture: StorageAcceptanceCapture; tickers: string[]; now?: Date;
}): Promise<Approval> {
  if (!env.OPS_DB || !env.MARKET_DATA_DB || !env.MARKET_HISTORY_DB) fail("bindings-missing");
  const now = input.now ?? new Date(), tickers = population(input.tickers), identity = input.capture.identity;
  if (env.EOD_CODE_REVISION !== identity.codeRevision || new Set(tickers).size !== tickers.length
    || !tickers.length || tickers.length > 10_000) fail("identity-mismatch");
  await validateStorageConsumerEvidence(input.consumers, input.capture, tickers);
  const { evidenceHash, ...unsignedPublications } = input.publications;
  if (await eodHash(unsignedPublications) !== evidenceHash || input.publications.tickerHash !== await eodHash(tickers)
    || await eodHash(input.publications.identity) !== await eodHash(identity)) fail("publication-evidence-mismatch");
  const report = object(input.analysis), models = Array.isArray(report.retentionModels) ? report.retentionModels.map(object) : [];
  const selected = models.find((row) => row.hotSessions === input.capacity.hotSessions), model = object(selected), database = object(model.database);
  const priceBytes = database.priceTableAndIndexBytes, physicalBytes = database.physicalBytes, headroom = model.sweepHeadroomSessions;
  const sourceSnapshotHash = object(report.source).snapshotSha256;
  if (await eodHash(input.analysis) !== input.capacity.analysisHash || !selected || !integer(priceBytes) || priceBytes <= 0
    || !integer(physicalBytes) || physicalBytes < priceBytes || !integer(headroom) || headroom < 10 || !digest(sourceSnapshotHash)
    || model.sharedTickers !== tickers.length || model.fallbackTickerReserve !== tickers.length
    || model.modeledSipRows !== tickers.length * (input.capacity.hotSessions + headroom) || model.modeledFallbackRows !== model.modeledSipRows
    || model.projectedBytes !== input.capacity.projectedMarketBytes
    || input.capacity.projectedMarketBytes !== physicalBytes + input.capacity.publicationGrowthReserveBytes
    || input.capacity.projectedMarketBytes >= 350_000_000 || input.capacity.projectedHistoryBytes >= 350_000_000
    || !integer(input.capacity.forecastSessions) || input.capacity.forecastSessions < 20) fail("measured-layout-required");
  const age = now.getTime() - Date.parse(input.capacity.measuredAt);
  if (!Number.isFinite(age) || age < 0 || age > 86_400_000) fail("accepted-capacity-expired");
  const future = await env.MARKET_DATA_DB.prepare(`SELECT session_date FROM market_calendar_sessions
    WHERE session_date>? ORDER BY session_date LIMIT ?`).bind(input.publications.sessionDate, input.capacity.forecastSessions).all<{ session_date: string }>();
  if (future.results.length !== input.capacity.forecastSessions) fail("forecast-calendar-incomplete");
  const lastCoveredSession = future.results.at(-1)!.session_date;
  const expiresAt = new Date(Date.parse(`${lastCoveredSession}T00:00:00Z`) + 86_400_000).toISOString();
  const proof: Approval["proof"] = { identity, tickerHash: await eodHash(tickers), tickers, publicationRunId: input.publications.runId,
    consumerProofHash: input.consumers.evidenceHash,
    readers: { contractVersion: input.consumers.readerContractVersion, checkedAt: input.consumers.completedAt,
      consumers: [...MARKET_HISTORY_REQUIRED_CONSUMERS], parityPassed: true, codeRevision: identity.codeRevision },
    capacity: input.capacity, model: { measuredAt: String(report.measuredAt), sourceSnapshotHash, priceTableAndIndexBytes: priceBytes,
      modeledPriceRows: Number(model.modeledSipRows) + Number(model.modeledFallbackRows), fullLayoutBytes: physicalBytes,
      hotSessions: input.capacity.hotSessions, sweepHeadroomSessions: headroom },
    horizon: { anchorSession: input.publications.sessionDate, lastCoveredSession, expiresAt, sessions: input.capacity.forecastSessions } };
  const proofHash = await eodHash(proof), id = `history-storage-approval:${identity.codeRevision}`;
  const existing = await read<Approval>(env.OPS_DB, id);
  if (existing?.proofHash === proofHash) return existing;
  const approved: Approval = { version: 1, kind: "storage-layout-v1", codeRevision: identity.codeRevision,
    approvedAt: now.toISOString(), proofHash, proof };
  // Keep every accepted measurement for audit; the small revision pointer may
  // advance only after its replacement has independently passed acceptance.
  await env.OPS_DB.prepare("INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING")
    .bind(`history-storage-proof:${proofHash}`, JSON.stringify(approved), now.toISOString()).run();
  await write(env.OPS_DB, id, approved, now);
  await write(env.OPS_DB, `history-storage-status:${identity.codeRevision}`, cachedStatus(approved,null,now), now);
  return approved;
}

async function loadApproval(env: Env, revision: string): Promise<Approval | null> {
  if (!env.OPS_DB) return null;
  const approved = await read<Approval>(env.OPS_DB, `history-storage-approval:${revision}`);
  if (!approved) return null;
  if (approved.version !== 1 || approved.kind !== "storage-layout-v1" || approved.codeRevision !== revision
    || env.EOD_CODE_REVISION !== revision || !digest(approved.proofHash) || await eodHash(approved.proof) !== approved.proofHash
    || approved.proof.identity.codeRevision !== revision || !Number.isFinite(Date.parse(approved.proof.horizon.expiresAt))) fail("approval-integrity");
  return approved;
}

/** Writers keep the approved hot window even when a capacity forecast expires;
 * expiration blocks pruning/acceptance, not a return to the larger legacy window. */
export async function loadApprovedStorageHotSessions(env: Env): Promise<260 | 90 | null> {
  if (!env.EOD_CODE_REVISION) return null;
  return (await loadApproval(env, env.EOD_CODE_REVISION))?.proof.model.hotSessions ?? null;
}

async function liveSize(db: D1Database): Promise<number> {
  const result = await db.prepare("SELECT 1 AS history_capacity_probe").all();
  const bytes = result.meta.size_after;
  if (!integer(bytes) || bytes <= 0) fail("physical-size-metadata-unavailable");
  return bytes;
}
async function revisions(env: Env, tickers: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  for (let offset = 0; offset < tickers.length; offset += 500) {
    const rows = await env.MARKET_DATA_DB!.prepare(`SELECT CAST(t.value AS TEXT) AS ticker,CAST(f.value AS TEXT) AS feed,
      COALESCE(r.revision,0) AS revision FROM json_each(?) t CROSS JOIN json_each(?) f
      LEFT JOIN eod_input_revisions r ON r.ticker=t.value AND r.feed=f.value`).bind(JSON.stringify(tickers.slice(offset, offset + 500)), JSON.stringify(FEEDS))
      .all<{ ticker: string; feed: Feed; revision: number }>();
    for (const row of rows.results) {
      if (!tickers.includes(row.ticker) || !FEEDS.includes(row.feed) || !integer(row.revision)) fail("revision-sample-invalid");
      result.set(`${row.feed}:${row.ticker}`, row.revision);
    }
  }
  if (result.size !== tickers.length * 2) fail("revision-sample-incomplete");
  return result;
}

/** Null means no storage-specific approval: the original legacy proof path
 * remains available. A present but expired/mismatched approval fails closed. */
export async function refreshStorageHistoryMaintenanceEvidence(env: Env, input: {
  tickers: string[]; codeRevision: string; now?: Date;
}): Promise<{ capacity: HistoryCapacityEvidence; readers: HistoryReaderEvidence; hotSessions: 260 | 90; feeds: readonly Feed[];
  sample: { measuredAt: string; sampledSymbols: number; sampledRows: number; proofHash: string; marketPhysicalBytes: number; archivePhysicalBytes: number } } | null> {
  const approved = await loadApproval(env, input.codeRevision);
  if (!approved) return null;
  if (!env.MARKET_DATA_DB || !env.MARKET_HISTORY_DB || !env.OPS_DB) fail("bindings-missing");
  const now = input.now ?? new Date(), { proof } = approved, tickers = population(input.tickers);
  const measurementId = `history-measurement:${input.codeRevision}`;
  let diagnostics: Record<string, unknown> = {};
  try {
    if (await eodHash(tickers) !== proof.tickerHash || new Set(tickers).size !== tickers.length) fail("population-changed-remeasurement-required");
    if (now.getTime() < Date.parse(approved.approvedAt) || now.getTime() >= Date.parse(proof.horizon.expiresAt)) fail("forecast-horizon-expired");
    const window = proof.model.hotSessions + proof.model.sweepHeadroomSessions;
    const before = await revisions(env, tickers), stateId = `history-storage-sample:${input.codeRevision}`;
    const saved = await read<{ proofHash: string; rowsHash: string; rows: Sample[] }>(env.OPS_DB, stateId);
    const reusable = new Map<string, Sample>();
    if (saved?.proofHash === approved.proofHash && Array.isArray(saved.rows) && await eodHash(saved.rows) === saved.rowsHash) {
      for (const row of saved.rows) {
        if (row.length !== 4 || !tickers.includes(row[0]) || !FEEDS.includes(row[1]) || !integer(row[2]) || !integer(row[3]) || row[3] > window) fail("sample-integrity");
        if (before.get(`${row[1]}:${row[0]}`) === row[2]) reusable.set(`${row[1]}:${row[0]}`, row);
      }
    }
    for (const feed of FEEDS) {
      const missing = tickers.filter((ticker) => !reusable.has(`${feed}:${ticker}`));
      for (let offset = 0; offset < missing.length; offset += 80) {
        const selected = missing.slice(offset, offset + 80);
        // At most 80*(retention+sweep+1) indexed rows per admitted query. The
        // extra observation detects overflow rather than truncating its count.
        const rows = await env.MARKET_DATA_DB.prepare(`/* eod-capacity-row-sample */ SELECT CAST(t.value AS TEXT) AS ticker,
          COALESCE(r.revision,0) AS revision,(SELECT COUNT(*) FROM (SELECT 1 FROM alpaca_daily_bars b
            WHERE b.feed=? AND b.ticker=t.value ORDER BY date DESC LIMIT ?)) AS retainedRows
          FROM json_each(?) t LEFT JOIN eod_input_revisions r ON r.feed=? AND r.ticker=t.value ORDER BY ticker`)
          .bind(feed, window + 1, JSON.stringify(selected), feed).all<{ ticker: string; revision: number; retainedRows: number }>();
        if (rows.results.length !== selected.length) fail("row-sample-incomplete");
        for (const row of rows.results) {
          if (!selected.includes(row.ticker) || !integer(row.revision) || !integer(row.retainedRows)) fail("row-sample-invalid");
          if (row.retainedRows > window) fail(`${feed}-retention-sweep-overflow`);
          reusable.set(`${feed}:${row.ticker}`, [row.ticker, feed, row.revision, row.retainedRows]);
        }
        const checkpoint = [...reusable.values()].sort((a, b) => `${a[1]}:${a[0]}`.localeCompare(`${b[1]}:${b[0]}`));
        await write(env.OPS_DB, stateId, { proofHash: approved.proofHash, rowsHash: await eodHash(checkpoint), rows: checkpoint }, now);
      }
    }
    const after = await revisions(env, tickers), samples = [...reusable.values()];
    if (samples.length !== tickers.length * 2 || samples.some((row) => after.get(`${row[1]}:${row[0]}`) !== row[2])) fail("inputs-changed-during-measurement");
    const [marketPhysicalBytes, archivePhysicalBytes] = await Promise.all([liveSize(env.MARKET_DATA_DB), liveSize(env.MARKET_HISTORY_DB)]);
    const sampledRows = samples.reduce((sum, row) => sum + row[3], 0), remainingHotRows = proof.model.modeledPriceRows - sampledRows;
    // This coefficient comes from exact populated SQLite table/index pages for
    // full-width dual-feed rows. No JSON-byte estimate or arbitrary multiplier.
    const priceBytesPerRowBound = Math.ceil(proof.model.priceTableAndIndexBytes / proof.model.modeledPriceRows);
    const additionalArchiveBytes = Math.max(0, proof.capacity.projectedHistoryBytes - proof.capacity.liveHistoryBytes);
    const projectedMarket = Math.max(proof.capacity.projectedMarketBytes,
      marketPhysicalBytes + remainingHotRows * priceBytesPerRowBound + proof.capacity.publicationGrowthReserveBytes);
    const projectedHistory = Math.max(proof.capacity.projectedHistoryBytes, archivePhysicalBytes + additionalArchiveBytes);
    const capacity: HistoryCapacityEvidence = { measuredAt: now.toISOString(), marketDatabaseBytes: marketPhysicalBytes,
      priceTableAndIndexBytes: proof.model.priceTableAndIndexBytes, priceRows: proof.model.modeledPriceRows,
      retainedPriceRows: proof.model.modeledPriceRows, archiveDatabaseBytes: archivePhysicalBytes, additionalArchiveBytes,
      liveProjection: { baselineMeasuredAt: proof.model.measuredAt, sampledRows, populationSize: tickers.length,
        remainingHotRows, priceBytesPerRowBound, marketBytes: projectedMarket, archiveBytes: projectedHistory } };
    const sample = { measuredAt: now.toISOString(), sampledSymbols: tickers.length, sampledRows, proofHash: approved.proofHash,
      marketPhysicalBytes, archivePhysicalBytes };
    diagnostics = { capacity, readers: proof.readers, sample, horizon: proof.horizon, analysisHash: proof.capacity.analysisHash,
      hotSessions: proof.model.hotSessions, feeds: FEEDS, feedRows: Object.fromEntries(FEEDS.map((feed) => [feed, samples.filter((row) => row[1] === feed).reduce((sum, row) => sum + row[3], 0)])) };
    assertHistoryPruneEvidence(capacity, proof.readers, now, input.codeRevision);
    const measurement = { status: "ready", ...diagnostics };
    await write(env.OPS_DB, measurementId, measurement, now);
    await write(env.OPS_DB, `history-storage-status:${input.codeRevision}`, cachedStatus(approved,measurement,now), now);
    return { capacity, readers: proof.readers, hotSessions: proof.model.hotSessions, feeds: FEEDS, sample };
  } catch (error) {
    const measurement = { status: "failed", ...diagnostics, measuredAt: now.toISOString(),
      horizon: proof.horizon, error: error instanceof Error ? error.message : "measurement-failed" };
    await write(env.OPS_DB, measurementId, measurement, now).catch(() => undefined);
    await write(env.OPS_DB, `history-storage-status:${input.codeRevision}`, cachedStatus(approved,measurement,now), now).catch(() => undefined);
    throw error;
  }
}

/** Independent daily monitor entry point. The full approved population comes
 * from its durable proof; the actual latest catalog detects additions/removals
 * before that prior population can be mistaken for current storage coverage. */
export async function refreshApprovedStorageHistoryCapacity(env: Env, now = new Date()) {
  if (!env.EOD_CODE_REVISION) return null;
  const approved = await loadApproval(env, env.EOD_CODE_REVISION);
  if (!approved) return null;
  if (!env.MARKET_DATA_DB) fail("bindings-missing");
  const current = await env.MARKET_DATA_DB.prepare(`SELECT json_extract(member.value,'$[0]') AS ticker
    FROM eod_publication_pointers h JOIN eod_publications p ON p.id=h.publication_id,
    json_each(CASE WHEN p.payload_codec='json' THEN p.payload_json ELSE '{}' END,'$.rows') member
    WHERE h.scope='history:catalog' AND p.scope=h.scope AND p.status='accepted' ORDER BY ticker LIMIT 10001 /* eod-history-catalog-read */`)
    .all<{ ticker: string }>();
  const tickers = current.results.map((row) => row.ticker);
  if (tickers.length > 10_000 || tickers.some((ticker) => typeof ticker !== "string")
    || await eodHash(tickers) !== approved.proof.tickerHash) {
    const failure = { status: "failed", measuredAt: now.toISOString(), error: "eod-history-storage-capacity-population-changed-remeasurement-required" };
    await write(env.OPS_DB!, `history-storage-status:${env.EOD_CODE_REVISION}`, cachedStatus(approved,failure,now), now);
    fail("population-changed-remeasurement-required");
  }
  return refreshStorageHistoryMaintenanceEvidence(env, { tickers: approved.proof.tickers, codeRevision: env.EOD_CODE_REVISION, now });
}

/** One small cached Ops record: never hashes the full ticker manifest or reads
 * prices/publications during inexpensive page metadata polling. */
export async function loadStorageHistoryCapacityStatus(env: Env, now = new Date()): Promise<StorageHistoryCapacityStatus | null> {
  if (!env.OPS_DB || !env.EOD_CODE_REVISION) return null;
  const status = await read<StorageHistoryCapacityStatus>(env.OPS_DB, `history-storage-status:${env.EOD_CODE_REVISION}`);
  if (!status) return null;
  if (!digest(status.proofHash) || !Number.isFinite(Date.parse(status.horizonExpiresAt))) fail("cached-status-invalid");
  if (now.getTime() >= Date.parse(status.horizonExpiresAt)) return { ...status, status: "expired", error: "forecast-horizon-expired" };
  if (status.status === "ready" && (!status.checkedAt || now.getTime() - Date.parse(status.checkedAt) > 86_400_000)) {
    return { ...status, status: "unmeasured", error: "live-capacity-measurement-stale" };
  }
  return status;
}
