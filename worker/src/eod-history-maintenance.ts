import { getMarketDataDb, marketDataFeed } from "./market-data-db";
import {
  archiveMarketHistoryBars, loadVerifiedArchivedMarketHistory, marketHistoryBarsMateriallyEqual,
  type MarketHistoryBar,
} from "./market-history";
import type { Env } from "./types";
import { EOD_CATALOG_SCOPE, loadEodCatalogRows } from "./eod-catalog-service";
import { eodHash } from "./eod-publication-service";

export const MARKET_HISTORY_READER_CONTRACT_VERSION = 1;
export const MARKET_HISTORY_REQUIRED_CONSUMERS = [
  "overview", "breadth", "correlation-5y", "patterns-520", "watchlist", "relative-strength",
  "scans", "ticker-max", "earnings-gaps", "coverage-and-repair",
] as const;
const CAPACITY_TARGET_BYTES = 350_000_000;
const MAX_MAINTENANCE_ROWS = 500;

export type HistoryCapacityEvidence = {
  measuredAt: string;
  marketDatabaseBytes: number;
  priceTableAndIndexBytes: number;
  priceRows: number;
  retainedPriceRows: number;
  archiveDatabaseBytes: number;
  /** Measured gzip sample extrapolation, including base64, indexes and two retained revisions. */
  additionalArchiveBytes: number;
  /** Live physical-size bound plus conservatively estimated remaining growth.
   * Original table ratios remain attributed to baselineMeasuredAt. */
  liveProjection?: {
    marketBytes: number;
    archiveBytes: number;
    baselineMeasuredAt: string;
    sampledRows: number;
    populationSize: number;
    remainingHotRows: number;
    priceBytesPerRowBound: number;
  };
};

export type HistoryReaderEvidence = {
  contractVersion: number;
  checkedAt: string;
  consumers: string[];
  parityPassed: boolean;
  /** Set only after a checksummed durable approval of the original parity proof. */
  codeRevision?: string;
};

/** This projects occupied storage, not immediate SQLite file shrinkage after DELETE. */
export function projectHistoryCapacity(input: HistoryCapacityEvidence): {
  marketBytes: number; archiveBytes: number; underTarget: boolean;
} {
  if (input.liveProjection) {
    const projection = input.liveProjection;
    const values = [input.marketDatabaseBytes, input.archiveDatabaseBytes, projection.marketBytes,
      projection.archiveBytes, projection.sampledRows, projection.populationSize, projection.remainingHotRows, projection.priceBytesPerRowBound];
    if (values.some((value) => !Number.isFinite(value) || value < 0)
      || input.marketDatabaseBytes === 0 || input.archiveDatabaseBytes === 0 || projection.populationSize === 0
      || projection.marketBytes < input.marketDatabaseBytes || projection.archiveBytes < input.archiveDatabaseBytes) {
      throw new Error("Live physical storage evidence is incomplete.");
    }
    return { marketBytes: projection.marketBytes, archiveBytes: projection.archiveBytes,
      underTarget: projection.marketBytes < CAPACITY_TARGET_BYTES && projection.archiveBytes < CAPACITY_TARGET_BYTES };
  }
  const values = [input.marketDatabaseBytes, input.priceTableAndIndexBytes, input.priceRows,
    input.retainedPriceRows, input.archiveDatabaseBytes, input.additionalArchiveBytes];
  if (values.some((value) => !Number.isFinite(value) || value < 0)
    || input.priceRows === 0 || input.priceTableAndIndexBytes === 0
    || input.priceTableAndIndexBytes > input.marketDatabaseBytes) throw new Error("Measured storage evidence is incomplete.");
  const marketBytes = Math.ceil(input.marketDatabaseBytes - input.priceTableAndIndexBytes
    + input.priceTableAndIndexBytes * input.retainedPriceRows / input.priceRows);
  const archiveBytes = Math.ceil(input.archiveDatabaseBytes + input.additionalArchiveBytes);
  return { marketBytes, archiveBytes, underTarget: marketBytes < CAPACITY_TARGET_BYTES && archiveBytes < CAPACITY_TARGET_BYTES };
}

export function assertHistoryPruneEvidence(
  capacity: HistoryCapacityEvidence, readers: HistoryReaderEvidence, now = new Date(), codeRevision?: string,
): void {
  const age = (value: string) => now.getTime() - Date.parse(value);
  if (!Number.isFinite(age(capacity.measuredAt)) || age(capacity.measuredAt) < 0 || age(capacity.measuredAt) > 86_400_000) {
    throw new Error("Capacity evidence must have been measured within the last UTC day.");
  }
  const approvedRevision = codeRevision != null && /^[a-f0-9]{40}$/i.test(codeRevision) && readers.codeRevision === codeRevision;
  if (!Number.isFinite(age(readers.checkedAt)) || age(readers.checkedAt) < 0 || (!approvedRevision && age(readers.checkedAt) > 7 * 86_400_000)
    || (codeRevision != null && !approvedRevision)
    || readers.contractVersion !== MARKET_HISTORY_READER_CONTRACT_VERSION || !readers.parityPassed
    || MARKET_HISTORY_REQUIRED_CONSUMERS.some((consumer) => !readers.consumers.includes(consumer))) {
    throw new Error("Every historical consumer must pass current archive parity before hot pruning.");
  }
  if (!projectHistoryCapacity(capacity).underTarget) throw new Error("Projected market and history storage must each remain below 350 MB.");
}

type MaintenanceEnv = Env & { EOD_ARCHIVE_PRUNE_ENABLED?: string };
export type HistoryMaintenanceCursor = { tickerIndex: number; afterDate?: string };
type PruneCatalogHead = { id: string; checksum: string; inputClock: number };
const pruneCatalogApprovals = new WeakMap<D1Database, { key: string; head: PruneCatalogHead }>();

/** Reusable only while both the immutable catalog and correction clock match.
 * Relocating verified identical rows is revision-neutral; genuine repairs defer
 * pruning until a reconcile run publishes a current full catalog. */
async function assertPruneCatalog(env: Env, tickers: string[], sessionDate: string): Promise<number> {
  const db = getMarketDataDb(env), key = `${sessionDate}:${JSON.stringify(tickers)}`;
  const readHead = () => db.prepare(`SELECT id,payload_checksum as checksum,
    (SELECT revision FROM eod_input_clock WHERE id='default') as inputClock
    FROM eod_publications WHERE scope=? AND session_date=? AND status='accepted'
    ORDER BY revision DESC,created_at DESC,id DESC LIMIT 1`).bind(EOD_CATALOG_SCOPE, sessionDate).first<PruneCatalogHead>();
  const defer = (reason: string): never => { throw new Error(`history-prune-deferred: ${reason}; reconcile must publish an accepted current full history catalog.`); };
  const head = await readHead();
  if (!head || !head.checksum || !Number.isSafeInteger(head.inputClock) || head.inputClock < 0) return defer("catalog or correction clock is unavailable");
  const cached = pruneCatalogApprovals.get(db);
  if (cached?.key === key && JSON.stringify(cached.head) === JSON.stringify(head)) return head.inputClock;
  const publication = await db.prepare("SELECT payload_json as payload,payload_codec as codec FROM eod_publications WHERE id=?")
    .bind(head.id).first<{payload:string;codec:string}>();
  let payload: {rows?:unknown};
  try { payload = JSON.parse(publication?.payload ?? "null") as {rows?:unknown}; } catch { return defer("catalog JSON is invalid"); }
  if (!payload || publication?.codec !== "json" || await eodHash(payload) !== head.checksum) return defer("catalog checksum or codec is invalid");
  const rows = payload.rows;
  if (!Array.isArray(rows) || rows.length !== tickers.length) return defer("catalog population is incomplete");
  const actual = new Set(rows.map((row) => Array.isArray(row) ? row[0] : null));
  if (actual.size !== tickers.length || tickers.some((ticker) => !actual.has(ticker))) return defer("catalog population differs from maintenance");
  try { await loadEodCatalogRows(env, tickers, sessionDate); } catch (error) {
    return defer(error instanceof Error ? error.message : "catalog revision validation failed");
  }
  if (JSON.stringify(await readHead()) !== JSON.stringify(head)) return defer("catalog inputs changed during validation");
  pruneCatalogApprovals.set(db, { key, head });
  return head.inputClock;
}

function relocationIdentity(alias: string): string {
  return `json_array(${alias}.o,${alias}.h,${alias}.l,${alias}.c,${alias}.volume,${alias}.reported_volume,
    ${alias}.reported_volume_collected_at,${alias}.source_provider,${alias}.adjustment,${alias}.observed_at,${alias}.fetched_at)`;
}

/** Registration, exact conditional deletion and marker removal are one D1
 * transaction. A manual writer cannot interleave while a marker exists. */
function relocationStatements(db: D1Database, bars: MarketHistoryBar[], cutoffDate: string, inputClock: number): D1PreparedStatement[] {
  const operation = crypto.randomUUID(), first = bars[0], serialized = JSON.stringify(bars);
  const dates = JSON.stringify(bars.map((bar) => bar.date));
  return [
    db.prepare(`INSERT INTO eod_history_relocations(feed,ticker,date,operation_id,bar_identity)
      SELECT b.feed,b.ticker,b.date,?,${relocationIdentity("b")} FROM json_each(?) expected
      JOIN alpaca_daily_bars b ON b.feed=? AND b.ticker=? AND b.date=json_extract(expected.value,'$.date')
      WHERE b.date<? AND (SELECT revision FROM eod_input_clock WHERE id='default')=?
        AND b.o IS json_extract(expected.value,'$.o') AND b.h IS json_extract(expected.value,'$.h')
        AND b.l IS json_extract(expected.value,'$.l') AND b.c IS json_extract(expected.value,'$.c')
        AND b.volume IS json_extract(expected.value,'$.volume') AND b.reported_volume IS json_extract(expected.value,'$.reportedVolume')
        AND b.reported_volume_collected_at IS json_extract(expected.value,'$.reportedVolumeCollectedAt')
        AND b.source_provider IS json_extract(expected.value,'$.sourceProvider') AND b.adjustment IS json_extract(expected.value,'$.adjustment')
        AND b.observed_at IS json_extract(expected.value,'$.observedAt') AND b.fetched_at IS json_extract(expected.value,'$.fetchedAt')
      ON CONFLICT(feed,ticker,date) DO NOTHING /* eod-history-relocation-register */`)
      .bind(operation, serialized, first.feed, first.ticker, cutoffDate, inputClock),
    db.prepare(`DELETE FROM alpaca_daily_bars WHERE EXISTS (SELECT 1 FROM eod_history_relocations relocation
        WHERE relocation.operation_id=? AND relocation.feed=alpaca_daily_bars.feed
          AND relocation.ticker=alpaca_daily_bars.ticker AND relocation.date=alpaca_daily_bars.date
          AND relocation.bar_identity IS ${relocationIdentity("alpaca_daily_bars")})
      AND date IN (SELECT value FROM json_each(?)) AND feed=? AND ticker=? /* eod-history-relocation-delete */`)
      .bind(operation, dates, first.feed, first.ticker),
    db.prepare(`DELETE FROM eod_history_relocations WHERE operation_id=?
      AND date IN (SELECT value FROM json_each(?)) AND feed=? AND ticker=? /* eod-history-relocation-cleanup */`)
      .bind(operation, dates, first.feed, first.ticker),
  ];
}

/**
 * Explicit maintenance entry point for the Node runner. It is never called by a page read.
 * Each row's financial values and source identity are archived, read back and
 * compared before a conditional exact-value DELETE. An unchanged archive keeps
 * its original truthful retrieval timestamps rather than replacing them on recheck.
 * Corrections racing this operation remain hot; archive rows are never globally expired.
 */
export async function archiveAndPruneMarketHistory(env: MaintenanceEnv, input: {
  tickers: string[];
  endDate: string;
  hotSessions?: 260 | 90;
  feed?: string;
  cursor?: HistoryMaintenanceCursor;
  maxRows?: number;
  capacity: HistoryCapacityEvidence;
  readers: HistoryReaderEvidence;
  now?: Date;
}): Promise<{
  status: "disabled" | "complete" | "partial";
  cursor: HistoryMaintenanceCursor | null;
  archivedRows: number; deletedRows: number; concurrentCorrections: number;
}> {
  const empty = { archivedRows: 0, deletedRows: 0, concurrentCorrections: 0 };
  if (env.EOD_ARCHIVE_PRUNE_ENABLED !== "true") return { status: "disabled", cursor: input.cursor ?? null, ...empty };
  if (!env.MARKET_HISTORY_DB || !["shadow", "active"].includes(env.EOD_RUNNER_MODE ?? "")) {
    throw new Error("Archive binding and migrated EOD storage are required before maintenance.");
  }
  assertHistoryPruneEvidence(input.capacity, input.readers, input.now, env.EOD_CODE_REVISION);
  const tickers = Array.from(new Set(input.tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean))).sort();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.endDate)
    || !Number.isFinite(Date.parse(`${input.endDate}T00:00:00Z`))
    || new Date(`${input.endDate}T00:00:00Z`).toISOString().slice(0, 10) !== input.endDate) throw new Error("Invalid maintenance session date.");
  const hotSessions = input.hotSessions ?? 260;
  if (hotSessions !== 260 && hotSessions !== 90) throw new Error("Unsupported hot-history retention.");
  const maxRows = Math.min(MAX_MAINTENANCE_ROWS, Math.max(1, Math.trunc(input.maxRows ?? MAX_MAINTENANCE_ROWS)));
  if (!Number.isFinite(maxRows)) throw new Error("Invalid maintenance row limit.");
  const startIndex = input.cursor?.tickerIndex ?? 0;
  if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex > tickers.length) throw new Error("Invalid maintenance cursor.");
  const db = getMarketDataDb(env);
  const feed = input.feed ?? marketDataFeed(env);
  if (feed !== "sip") throw new Error("Verified retention requires the canonical SIP history catalog.");
  await assertPruneCatalog(env, tickers, input.endDate);
  let archivedRows = 0;
  let deletedRows = 0;
  let concurrentCorrections = 0;
  for (let tickerIndex = startIndex; tickerIndex < tickers.length; tickerIndex += 1) {
    const ticker = tickers[tickerIndex];
    const cutoff = await db.prepare(`SELECT MIN(date) as cutoffDate, COUNT(*) as retainedRows FROM (
      SELECT date FROM alpaca_daily_bars WHERE feed = ? AND ticker = ? AND date <= ? ORDER BY date DESC LIMIT ?
    )`).bind(feed, ticker, input.endDate, hotSessions).first<{ cutoffDate: string | null; retainedRows: number }>();
    if (!cutoff?.cutoffDate || Number(cutoff.retainedRows) < hotSessions) continue;
    const afterDate = tickerIndex === startIndex ? input.cursor?.afterDate ?? "0001-01-01" : "0001-01-01";
    const remaining = maxRows - archivedRows;
    const candidates = (await db.prepare(`SELECT ticker,date,o,h,l,c,volume,reported_volume as reportedVolume,reported_volume_collected_at as reportedVolumeCollectedAt,feed,
      source_provider as sourceProvider,adjustment,observed_at as observedAt,fetched_at as fetchedAt
      FROM alpaca_daily_bars WHERE feed = ? AND ticker = ? AND date < ? AND date > ? ORDER BY date LIMIT ?`)
      .bind(feed, ticker, cutoff.cutoffDate, afterDate, remaining).all<MarketHistoryBar>()).results ?? [];
    if (!candidates.length) continue;
    await archiveMarketHistoryBars(env, candidates, { verifiedHotRelocation: true });
    const archived = await loadVerifiedArchivedMarketHistory(env, {
      tickers: [ticker], feed, startDate: candidates[0].date, endDate: candidates.at(-1)!.date,
    });
    const byDate = new Map(archived.map((bar) => [bar.date, bar]));
    for (const candidate of candidates) {
      const verified = byDate.get(candidate.date);
      if (!verified || !marketHistoryBarsMateriallyEqual(candidate, verified)) {
        throw new Error(`Archive parity failed for ${ticker} ${candidate.date}; no candidate rows were pruned.`);
      }
    }
    for (let offset = 0; offset < candidates.length; offset += 40) {
      const inputClock = await assertPruneCatalog(env, tickers, input.endDate);
      const result = await db.batch(relocationStatements(db, candidates.slice(offset, offset + 40), cutoff.cutoffDate, inputClock));
      deletedRows += Number(result[1]?.meta?.changes ?? 0);
    }
    archivedRows += candidates.length;
    concurrentCorrections = archivedRows - deletedRows;
    if (archivedRows >= maxRows) return {
      status: "partial", cursor: { tickerIndex, afterDate: candidates.at(-1)!.date }, archivedRows, deletedRows, concurrentCorrections,
    };
  }
  return { status: "complete", cursor: null, archivedRows, deletedRows, concurrentCorrections };
}

/** Bounded PK scan; keeps both active and previous revisions and fresh in-flight blocks. */
export async function cleanupUnpointedHistoryBlocks(env: MaintenanceEnv, input: {
  cursor?: string; maxRows?: number; now?: Date;
} = {}): Promise<{ status: "disabled" | "complete" | "partial"; cursor: string | null; deletedBlocks: number }> {
  if (env.EOD_ARCHIVE_PRUNE_ENABLED !== "true" || !env.MARKET_HISTORY_DB) {
    return { status: "disabled", cursor: input.cursor ?? null, deletedBlocks: 0 };
  }
  const limit = Math.min(100, Math.max(1, Math.trunc(input.maxRows ?? 40)));
  if (!Number.isFinite(limit)) throw new Error("Invalid history cleanup limit.");
  const db = env.MARKET_HISTORY_DB;
  const candidates = (await db.prepare(`SELECT id,feed,ticker,calendar_year as calendarYear
    FROM market_history_blocks WHERE id > ? ORDER BY id LIMIT ?`)
    .bind(input.cursor ?? "", limit).all<{ id: string; feed: string; ticker: string; calendarYear: number }>()).results ?? [];
  const olderThan = new Date((input.now ?? new Date()).getTime() - 86_400_000).toISOString();
  let deletedBlocks = 0;
  for (const row of candidates) {
    const result = await db.prepare(`DELETE FROM market_history_blocks WHERE id = ? AND datetime(created_at) < datetime(?)
      AND NOT EXISTS (SELECT 1 FROM market_history_block_pointers WHERE feed = ? AND ticker = ? AND calendar_year = ?
        AND (block_id = ? OR previous_block_id = ?))`)
      .bind(row.id, olderThan, row.feed, row.ticker, row.calendarYear, row.id, row.id).run();
    deletedBlocks += Number(result.meta?.changes ?? 0);
  }
  return { status: candidates.length === limit ? "partial" : "complete",
    cursor: candidates.length === limit ? candidates.at(-1)!.id : null, deletedBlocks };
}
