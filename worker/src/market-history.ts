import { getMarketDataDb, marketDataFeed } from "./market-data-db";
import type { Env } from "./types";
import { assertYahooArchiveCapacity, EodFallbackStorageFullError, reserveYahooArchiveBlock } from "./eod-fallback-storage";

export const MARKET_HISTORY_SCHEMA_VERSION = 1;
export const MARKET_HISTORY_HOT_SESSIONS = 260;
export const MARKET_HISTORY_MIN_CLOSE_SESSIONS = 1_300;
export const MARKET_HISTORY_MIN_OHLCV_SESSIONS = 520;
const HISTORY_QUERY_CHUNK_SIZE = 80;
const MAX_BLOCK_BYTES = 1_500_000;
const HISTORY_CODEC = "gzip-json-v1";

/** Lossless stored prices: callers decide whether null volume is usable. */
export type MarketHistoryBar = {
  ticker: string;
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
  volume: number | null;
  reportedVolume?: number | null;
  reportedVolumeCollectedAt?: string | null;
  feed: string;
  sourceProvider: string;
  adjustment: string;
  observedAt: string | null;
  fetchedAt: string | null;
};

export type MarketHistoryInput = {
  tickers: string[];
  startDate?: string;
  endDate?: string;
  limitPerTicker?: number;
  feed?: string;
  sourceProvider?: string;
  adjustment?: string;
  onD1Usage?: (usage: { rowsRead: number; rowsWritten: number }) => void;
  /** Restricted to adjustment repair and coverage bookkeeping; normal price readers fail closed. */
  allowPendingAdjustmentRepair?: boolean;
};

export type MarketHistoryBlock = {
  id: string;
  feed: string;
  ticker: string;
  calendarYear: number;
  schemaVersion: number;
  codec: string;
  checksum: string;
  rowCount: number;
  firstDate: string;
  lastDate: string;
  uncompressedBytes: number;
  payloadBase64: string;
  verifiedAt?: string | null;
  previousBlockId?: string | null;
};

type HistoryEnv = Env & { MARKET_HISTORY_DB?: D1Database; EOD_RUNNER_MODE?: string };
type BlockPayload = { schemaVersion: 1; bars: MarketHistoryBar[] };

export class MarketHistoryIntegrityError extends Error {
  readonly code = "market-history-integrity";
  constructor(message: string) {
    super(message);
    this.name = "MarketHistoryIntegrityError";
  }
}

function fail(message: string): never {
  throw new MarketHistoryIntegrityError(message);
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function normalizeBar(input: MarketHistoryBar): MarketHistoryBar {
  if (!input || typeof input !== "object") fail("Archive row must be an object.");
  const ticker = input.ticker?.trim().toUpperCase();
  const feed = input.feed?.trim().toLowerCase();
  if (!ticker || !feed || !validDate(input.date)) fail("Archive row has an invalid security, feed or session date.");
  for (const key of ["o", "h", "l", "c"] as const) {
    if (typeof input[key] !== "number" || !Number.isFinite(input[key])) fail(`Archive row has invalid ${key}.`);
  }
  if (input.volume !== null && (typeof input.volume !== "number" || !Number.isFinite(input.volume))) {
    fail("Archive row has invalid volume.");
  }
  if (input.reportedVolume != null && (typeof input.reportedVolume !== "number" || !Number.isFinite(input.reportedVolume))) {
    fail("Archive row has invalid reported volume.");
  }
  if (typeof input.sourceProvider !== "string" || !input.sourceProvider
    || typeof input.adjustment !== "string" || !input.adjustment) fail("Archive row has no source provenance.");
  if ((input.observedAt !== null && typeof input.observedAt !== "string")
    || (input.fetchedAt !== null && typeof input.fetchedAt !== "string")) fail("Archive row has invalid timestamps.");
  if (input.reportedVolumeCollectedAt!=null && (typeof input.reportedVolumeCollectedAt!=="string"
    || !Number.isFinite(Date.parse(input.reportedVolumeCollectedAt)))) fail("Archive row has invalid volume collection time.");
  return {
    ticker, date: input.date, o: input.o, h: input.h, l: input.l, c: input.c,
    volume: input.volume, reportedVolume: input.reportedVolume ?? null,
    ...(input.reportedVolumeCollectedAt===undefined ? {} : {reportedVolumeCollectedAt:input.reportedVolumeCollectedAt}),
    feed, sourceProvider: input.sourceProvider, adjustment: input.adjustment,
    observedAt: input.observedAt, fetchedAt: input.fetchedAt,
  };
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8_192));
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return fail("Archive payload is not valid base64.");
  }
}

async function readBoundedStream(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        fail("Archive payload exceeds its maximum decoded size.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function byteStream(bytes: Uint8Array): ReadableStream<BufferSource> {
  return new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Encoding does not round prices or replace nulls. Each block owns one feed/security/year. */
export async function encodeMarketHistoryBlock(input: MarketHistoryBar[]): Promise<MarketHistoryBlock> {
  if (input.length === 0) fail("An archive block cannot be empty.");
  const bars = input.map(normalizeBar).sort((a, b) => a.date.localeCompare(b.date));
  const first = bars[0];
  const year = Number(first.date.slice(0, 4));
  const dates = new Set<string>();
  for (const bar of bars) {
    if (bar.ticker !== first.ticker || bar.feed !== first.feed || Number(bar.date.slice(0, 4)) !== year) {
      fail("Archive block mixes securities, feeds or calendar years.");
    }
    if (dates.has(bar.date)) fail("Archive block has duplicate session dates.");
    dates.add(bar.date);
  }
  const payload: BlockPayload = { schemaVersion: MARKET_HISTORY_SCHEMA_VERSION, bars };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  if (bytes.length > MAX_BLOCK_BYTES) fail("Archive block exceeds the supported size.");
  const checksum = await sha256(bytes);
  const compressed = await readBoundedStream(byteStream(bytes).pipeThrough(new CompressionStream("gzip")), MAX_BLOCK_BYTES);
  return {
    id: `${first.feed}:${first.ticker}:${year}:${checksum}`,
    feed: first.feed, ticker: first.ticker, calendarYear: year,
    schemaVersion: MARKET_HISTORY_SCHEMA_VERSION, codec: HISTORY_CODEC, checksum,
    rowCount: bars.length, firstDate: first.date, lastDate: bars.at(-1)!.date,
    uncompressedBytes: bytes.length, payloadBase64: encodeBase64(compressed),
  };
}

/** Verifies both bytes and manifest; corrupt archive data is never silently served. */
export async function decodeMarketHistoryBlock(block: MarketHistoryBlock): Promise<MarketHistoryBar[]> {
  if (block.schemaVersion !== MARKET_HISTORY_SCHEMA_VERSION || block.codec !== HISTORY_CODEC) {
    fail("Unsupported market-history archive version or codec.");
  }
  if (!Number.isInteger(block.uncompressedBytes) || block.uncompressedBytes <= 0 || block.uncompressedBytes > MAX_BLOCK_BYTES
    || typeof block.payloadBase64 !== "string" || block.payloadBase64.length > MAX_BLOCK_BYTES * 4 / 3 + 4) {
    fail("Invalid archive payload size.");
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedStream(
      byteStream(decodeBase64(block.payloadBase64)).pipeThrough(new DecompressionStream("gzip")),
      block.uncompressedBytes,
    );
  } catch (error) {
    if (error instanceof MarketHistoryIntegrityError) throw error;
    return fail("Archive gzip payload could not be decoded.");
  }
  if (bytes.length !== block.uncompressedBytes || await sha256(bytes) !== block.checksum) {
    fail("Archive checksum or decoded size does not match its manifest.");
  }
  let payload: BlockPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes)) as BlockPayload;
  } catch {
    return fail("Archive JSON payload is invalid.");
  }
  if (payload.schemaVersion !== MARKET_HISTORY_SCHEMA_VERSION || !Array.isArray(payload.bars)) {
    fail("Archive JSON schema is invalid.");
  }
  const bars = payload.bars.map(normalizeBar);
  if (bars.length !== block.rowCount || bars.length === 0 || bars[0].date !== block.firstDate || bars.at(-1)!.date !== block.lastDate) {
    fail("Archive row count or date bounds do not match its manifest.");
  }
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    if (bar.ticker !== block.ticker || bar.feed !== block.feed || Number(bar.date.slice(0, 4)) !== block.calendarYear
      || (i > 0 && bars[i - 1].date >= bar.date)) fail("Archive rows do not match their security/year manifest.");
  }
  if (block.id !== `${block.feed}:${block.ticker}:${block.calendarYear}:${block.checksum}`) fail("Archive block identity is invalid.");
  return bars;
}

const BLOCK_COLUMNS = `b.id, b.feed, b.ticker, b.calendar_year as calendarYear,
  b.schema_version as schemaVersion, b.codec, b.checksum, b.row_count as rowCount,
  b.first_date as firstDate, b.last_date as lastDate,
  b.uncompressed_bytes as uncompressedBytes, b.payload_base64 as payloadBase64, b.verified_at as verifiedAt`;

async function loadArchiveBlocks(env: HistoryEnv, tickers: string[], feed: string, startDate: string, endDate: string, onD1Usage?: MarketHistoryInput["onD1Usage"]): Promise<MarketHistoryBlock[]> {
  if (!env.MARKET_HISTORY_DB) return [];
  const result = await env.MARKET_HISTORY_DB.prepare(
    `SELECT ${BLOCK_COLUMNS}, p.previous_block_id as previousBlockId
       FROM market_history_block_pointers p
       JOIN market_history_blocks b ON b.id = p.block_id
      WHERE p.feed = ? AND p.ticker IN (SELECT CAST(value AS TEXT) FROM json_each(?))
        AND p.calendar_year BETWEEN ? AND ?
        AND b.first_date <= ? AND b.last_date >= ?`,
  ).bind(feed, JSON.stringify(tickers), Number(startDate.slice(0, 4)), Number(endDate.slice(0, 4)), endDate, startDate)
    .all<MarketHistoryBlock>();
  onD1Usage?.({ rowsRead: Number(result.meta?.rows_read ?? 0), rowsWritten: Number(result.meta?.rows_written ?? 0) });
  const blocks = result.results ?? [];
  if (blocks.some((block) => !block.verifiedAt)) fail("An active archive block has not been verified.");
  return blocks;
}

/**
 * One range contract for hot + archived prices. Hot corrections take precedence.
 * No archive binding preserves the existing hot-store behavior; no pruning is performed here.
 */
export async function loadMarketHistory(env: HistoryEnv, input: MarketHistoryInput): Promise<MarketHistoryBar[]> {
  const tickers = Array.from(new Set(input.tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean)));
  if (tickers.length === 0) return [];
  const startDate = input.startDate ?? "0001-01-01";
  const endDate = input.endDate ?? "9999-12-31";
  if (!validDate(startDate) || !validDate(endDate)) throw new Error("Invalid market-history date range.");
  if (startDate > endDate) return [];
  if (input.limitPerTicker != null && !Number.isFinite(input.limitPerTicker)) throw new Error("Invalid market-history session limit.");
  const limit = input.limitPerTicker == null ? null : Math.max(0, Math.trunc(input.limitPerTicker));
  if (limit === 0) return [];
  const feed = input.feed ?? marketDataFeed(env);
  const db = getMarketDataDb(env);
  const output: MarketHistoryBar[] = [];
  for (let offset = 0; offset < tickers.length; offset += HISTORY_QUERY_CHUNK_SIZE) {
    const chunk = tickers.slice(offset, offset + HISTORY_QUERY_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const readFence = async (): Promise<string | null> => {
      if ((env.EOD_READ_ENABLED !== "true" && !["shadow", "active"].includes(env.EOD_RUNNER_MODE ?? ""))
        || input.allowPendingAdjustmentRepair) return null;
      const state = await db.prepare(`SELECT CAST(requested.value AS TEXT) as ticker,COALESCE(r.revision,0) as revision,f.status
        FROM json_each(?) requested LEFT JOIN eod_input_revisions r ON r.feed=? AND r.ticker=requested.value
        LEFT JOIN eod_adjustment_repairs f ON f.feed=? AND f.ticker=requested.value ORDER BY ticker`)
        .bind(JSON.stringify(chunk), feed, feed).all<{ ticker: string; revision: number; status: string | null }>();
      input.onD1Usage?.({ rowsRead: Number(state.meta?.rows_read ?? 0), rowsWritten: 0 });
      const pending = state.results?.find((row) => row.status === "pending");
      if (pending) throw new Error(`market-history-adjustment-repair-pending:${pending.ticker}`);
      return JSON.stringify(state.results ?? []);
    };
    const initialFence = await readFence();
    const conditions = ["feed = ?", `ticker IN (${placeholders})`, "date >= ?", "date <= ?"];
    const bindings: unknown[] = [feed, ...chunk, startDate, endDate];
    if (input.sourceProvider) { conditions.push("source_provider = ?"); bindings.push(input.sourceProvider); }
    if (input.adjustment) { conditions.push("adjustment = ?"); bindings.push(input.adjustment); }
    const reportedVolume = env.EOD_READ_ENABLED === "true" || env.EOD_RUNNER_MODE === "shadow" || env.EOD_RUNNER_MODE === "active"
      ? "reported_volume" : "NULL";
    const volumeCollectedAt=reportedVolume==="NULL" ? "NULL" : "reported_volume_collected_at";
    const select = `SELECT ticker, date, o, h, l, c, volume, ${reportedVolume} as reportedVolume, feed,
      ${volumeCollectedAt} as reportedVolumeCollectedAt,
      source_provider as sourceProvider, adjustment, observed_at as observedAt, fetched_at as fetchedAt`;
    const sql = limit == null
      ? `${select} FROM alpaca_daily_bars WHERE ${conditions.join(" AND ")} ORDER BY ticker, date`
      : `SELECT * FROM (${select}, ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) AS row_num
          FROM alpaca_daily_bars WHERE ${conditions.join(" AND ")}) WHERE row_num <= ? ORDER BY ticker, date`;
    if (limit != null) bindings.push(limit);
    const result = await db.prepare(sql).bind(...bindings).all<MarketHistoryBar>();
    input.onD1Usage?.({ rowsRead: Number(result.meta?.rows_read ?? 0), rowsWritten: Number(result.meta?.rows_written ?? 0) });
    const byTicker = new Map<string, Map<string, MarketHistoryBar>>();
    const add = (bar: MarketHistoryBar) => {
      if (bar.date < startDate || bar.date > endDate || !chunk.includes(bar.ticker)) return;
      if (input.sourceProvider && bar.sourceProvider !== input.sourceProvider) return;
      if (input.adjustment && bar.adjustment !== input.adjustment) return;
      const rows = byTicker.get(bar.ticker) ?? new Map<string, MarketHistoryBar>();
      rows.set(bar.date, bar);
      byTicker.set(bar.ticker, rows);
    };
    const hotRows = result.results ?? [];
    if (env.MARKET_HISTORY_DB) {
      const blocks = await loadArchiveBlocks(env, chunk, feed, startDate, endDate, input.onD1Usage);
      for (const block of blocks) {
        const hotDates = hotRows.filter((bar) => bar.ticker === block.ticker).map((bar) => bar.date).sort();
        // A block entirely older than the final N hot rows cannot change a trailing query.
        if (limit != null && hotDates.length >= limit && block.lastDate < hotDates[hotDates.length - limit]) continue;
        for (const bar of await decodeMarketHistoryBlock(block)) add(bar);
      }
    }
    for (const row of hotRows) add({
      ticker: row.ticker, date: row.date, o: row.o, h: row.h, l: row.l, c: row.c, volume: row.volume,
      feed: row.feed ?? feed, sourceProvider: row.sourceProvider ?? input.sourceProvider ?? "alpaca",
      adjustment: row.adjustment ?? input.adjustment ?? env.ALPACA_DAILY_ADJUSTMENT ?? "split",
      reportedVolume: row.reportedVolume ?? null,
      ...(row.reportedVolumeCollectedAt ? {reportedVolumeCollectedAt:row.reportedVolumeCollectedAt} : {}),
      observedAt: row.observedAt ?? null, fetchedAt: row.fetchedAt ?? null,
    });
    if (initialFence !== await readFence()) throw new Error("market-history-inputs-changed-during-read");
    for (const ticker of chunk) {
      const rows = Array.from(byTicker.get(ticker)?.values() ?? []).sort((a, b) => a.date.localeCompare(b.date));
      output.push(...(limit == null ? rows : rows.slice(-limit)));
    }
  }
  return output.sort((a, b) => a.ticker.localeCompare(b.ticker) || a.date.localeCompare(b.date));
}

/** Archive-only read for maintenance parity checks; hot rows cannot conceal a missing block. */
export async function loadVerifiedArchivedMarketHistory(env: HistoryEnv, input: MarketHistoryInput): Promise<MarketHistoryBar[]> {
  if (!env.MARKET_HISTORY_DB) throw new Error("MARKET_HISTORY_DB is required for archive verification.");
  const tickers = Array.from(new Set(input.tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean)));
  const startDate = input.startDate ?? "0001-01-01";
  const endDate = input.endDate ?? "9999-12-31";
  if (!validDate(startDate) || !validDate(endDate)) throw new Error("Invalid archive verification date range.");
  const rows: MarketHistoryBar[] = [];
  for (let offset = 0; offset < tickers.length; offset += HISTORY_QUERY_CHUNK_SIZE) {
    for (const block of await loadArchiveBlocks(env, tickers.slice(offset, offset + HISTORY_QUERY_CHUNK_SIZE),
      input.feed ?? marketDataFeed(env), startDate, endDate, input.onD1Usage)) {
      for (const bar of await decodeMarketHistoryBlock(block)) {
        if (bar.date >= startDate && bar.date <= endDate
          && (!input.sourceProvider || bar.sourceProvider === input.sourceProvider)
          && (!input.adjustment || bar.adjustment === input.adjustment)) rows.push(bar);
      }
    }
  }
  return rows.sort((a, b) => a.ticker.localeCompare(b.ticker) || a.date.localeCompare(b.date));
}

/** Exact observation identity, including its retrieval timestamps. */
export function marketHistoryBarsEqual(left: MarketHistoryBar, right: MarketHistoryBar): boolean {
  return JSON.stringify(normalizeBar(left)) === JSON.stringify(normalizeBar(right));
}

/** An unchanged recheck retains the original truthful retrieval timestamps.
 * The run checkpoint records verification time; financial values and source
 * identity still have to match exactly before a stored observation is reused. */
export function marketHistoryBarsMateriallyEqual(left: MarketHistoryBar, right: MarketHistoryBar): boolean {
  const material = (bar: MarketHistoryBar) => {
    const { observedAt: _observedAt, fetchedAt: _fetchedAt, reportedVolumeCollectedAt: _volumeCollectedAt, ...fields } = normalizeBar(bar);
    return fields;
  };
  return JSON.stringify(material(left)) === JSON.stringify(material(right));
}

/** Compatibility projection for consumers whose existing OHLCV contract uses zero for absent volume. */
export async function loadMarketHistoryOhlcv(env: HistoryEnv, input: MarketHistoryInput): Promise<Array<MarketHistoryBar & { volume: number }>> {
  return (await loadMarketHistory(env, input)).map((bar) => ({ ...bar, volume: bar.volume ?? 0 }));
}

export async function loadMarketHistoryCoverage(env: HistoryEnv, input: MarketHistoryInput): Promise<Map<string, {
  ticker: string; firstDate: string; lastDate: string; barCount: number;
}>> {
  const result = new Map<string, { ticker: string; firstDate: string; lastDate: string; barCount: number }>();
  // Counts and date bounds remain useful while a correction is fenced; they do not certify price usability.
  for (const bar of await loadMarketHistory(env, { ...input, allowPendingAdjustmentRepair: true })) {
    const current = result.get(bar.ticker);
    if (current) {
      current.lastDate = bar.date;
      current.barCount += 1;
    } else {
      result.set(bar.ticker, { ticker: bar.ticker, firstDate: bar.date, lastDate: bar.date, barCount: 1 });
    }
  }
  return result;
}

/** Archive-first helper. Does not delete hot data or enable retention changes. */
export async function archiveMarketHistoryBars(env: HistoryEnv, input: MarketHistoryBar[], options: {
  repairFenceToken?: string;
  /** Internal retention only: exact hot copies, never archive corrections. */
  verifiedHotRelocation?: true;
} = {}): Promise<{
  blocks: Array<Omit<MarketHistoryBlock, "payloadBase64">>;
  rowsRead: number;
  rowsWritten: number;
  revisionChanges: Array<{ feed: string; ticker: string; count: number }>;
}> {
  const db = env.MARKET_HISTORY_DB;
  if (!db) throw new Error("MARKET_HISTORY_DB is required to archive market history.");
  if (options.verifiedHotRelocation && (env.EOD_ARCHIVE_PRUNE_ENABLED !== "true"
    || !["shadow", "active"].includes(env.EOD_RUNNER_MODE ?? "") || options.repairFenceToken || input.length > 500
    || input.some((bar) => !["sip", "yahoo-eod"].includes(bar.feed.trim().toLowerCase())))) {
    fail("Verified hot relocation is restricted to bounded enabled retention.");
  }
  const groups = new Map<string, MarketHistoryBar[]>();
  for (const item of input) {
    const bar = normalizeBar(item);
    const key = `${bar.feed}:${bar.ticker}:${bar.date.slice(0, 4)}`;
    const group = groups.get(key) ?? [];
    group.push(bar);
    groups.set(key, group);
  }
  const manifests: Array<Omit<MarketHistoryBlock, "payloadBase64">> = [];
  let rowsRead = 0;
  let rowsWritten = 0;
  const revisionChanges = new Map<string, { feed: string; ticker: string; count: number }>();
  const fences = new Map<string, { feed: string; ticker: string; token: string; owned: boolean }>();
  const revisionEnabled = env.EOD_READ_ENABLED === "true" || ["shadow", "active"].includes(env.EOD_RUNNER_MODE ?? "");
  const marketDb = getMarketDataDb(env);
  const bumpRevision = async (feed: string, ticker: string, lastDate: string) => {
    if (!revisionEnabled || options.verifiedHotRelocation) return;
    const result = await marketDb.prepare(`INSERT INTO eod_input_revisions
      (feed,ticker,revision,semantic_revision,last_correction_revision,append_high_water_date)
      VALUES(?,?,1,1,1,?) ON CONFLICT(feed,ticker) DO UPDATE SET
        revision=revision+1,semantic_revision=revision+1,last_correction_revision=revision+1,
        append_high_water_date=CASE WHEN append_high_water_date IS NULL OR append_high_water_date<excluded.append_high_water_date
          THEN excluded.append_high_water_date ELSE append_high_water_date END,
        append_epoch_start_revision=NULL,append_epoch_start_date=NULL,updated_at=CURRENT_TIMESTAMP`)
      .bind(feed, ticker, lastDate).run();
    rowsRead += Number(result.meta?.rows_read ?? 0);
    rowsWritten += Number(result.meta?.rows_written ?? result.meta?.changes ?? 0);
    const key = `${feed}:${ticker}`;
    const change = revisionChanges.get(key) ?? { feed, ticker, count: 0 };
    change.count += 1;
    revisionChanges.set(key, change);
  };
  let completed = false;
  try {
    for (const incoming of groups.values()) {
      const first = incoming[0];
      const year = first.date.slice(0, 4);
      const current = await loadArchiveBlocks(env, [first.ticker], first.feed, `${year}-01-01`, `${year}-12-31`, (usage) => { rowsRead += usage.rowsRead; });
      const merged = new Map<string, MarketHistoryBar>();
      for (const block of current) for (const row of await decodeMarketHistoryBlock(block)) merged.set(row.date, row);
      if (options.verifiedHotRelocation) {
        const hot = await marketDb.prepare(`SELECT ticker,date,o,h,l,c,volume,reported_volume as reportedVolume,
          reported_volume_collected_at as reportedVolumeCollectedAt,feed,source_provider as sourceProvider,
          adjustment,observed_at as observedAt,fetched_at as fetchedAt FROM alpaca_daily_bars
          WHERE feed=? AND ticker=? AND date IN (SELECT value FROM json_each(?))`)
          .bind(first.feed, first.ticker, JSON.stringify(incoming.map((bar) => bar.date))).all<MarketHistoryBar>();
        rowsRead += Number(hot.meta?.rows_read ?? hot.results.length);
        const byDate = new Map(hot.results.map((bar) => [bar.date, bar]));
        for (const row of incoming) {
          const stored = byDate.get(row.date), prior = merged.get(row.date);
          if (!stored || !marketHistoryBarsEqual({ ...row, reportedVolumeCollectedAt: row.reportedVolumeCollectedAt ?? null },
            { ...stored, reportedVolumeCollectedAt: stored.reportedVolumeCollectedAt ?? null })) {
            fail(`Verified hot relocation changed before archiving ${row.ticker} ${row.date}.`);
          }
          if (prior && !marketHistoryBarsMateriallyEqual(prior, row)) {
            fail(`Verified hot relocation cannot repair conflicting archived prices for ${row.ticker} ${row.date}.`);
          }
        }
      }
      for (const row of incoming) {
        const prior = merged.get(row.date);
        if (!prior || !marketHistoryBarsMateriallyEqual(prior, row)) merged.set(row.date, row);
      }
      const encoded = await encodeMarketHistoryBlock(Array.from(merged.values()));
      if (current[0]?.id === encoded.id) {
        const { payloadBase64: _payload, ...manifest } = current[0];
        manifests.push(manifest);
        continue;
      }
      if (encoded.feed === "yahoo-eod") {
        await assertYahooArchiveCapacity(db, encoded.ticker);
      }
      const security = `${encoded.feed}:${encoded.ticker}`;
      if (revisionEnabled && !fences.has(security)) {
        const token = options.repairFenceToken ?? crypto.randomUUID();
        if (options.repairFenceToken) {
          const fence = await marketDb.prepare("SELECT status,owner_token as ownerToken FROM eod_adjustment_repairs WHERE feed=? AND ticker=?")
            .bind(encoded.feed, encoded.ticker).first<{ status: string; ownerToken: string | null }>();
          rowsRead += 1;
          if (fence?.status !== "pending" || fence.ownerToken !== token) fail("Archive repair fence ownership was lost.");
        } else {
          const opened = await marketDb.prepare(`INSERT INTO eod_adjustment_repairs(feed,ticker,status,start_date,updated_at,owner_token)
            VALUES(?,?,'pending',?,?,?) ON CONFLICT(feed,ticker) DO UPDATE SET
              status='pending',start_date=excluded.start_date,updated_at=excluded.updated_at,owner_token=excluded.owner_token
            WHERE eod_adjustment_repairs.status='complete' RETURNING owner_token AS ownerToken`)
            .bind(encoded.feed, encoded.ticker, encoded.firstDate, new Date().toISOString(), token).all<{ ownerToken: string }>();
          rowsRead += Number(opened.meta?.rows_read ?? 0);
          rowsWritten += Number(opened.meta?.rows_written ?? opened.meta?.changes ?? 0);
          if (opened.results.length !== 1 || opened.results[0].ownerToken !== token) fail("Archive security already has a pending adjustment repair.");
        }
        fences.set(security, { feed: encoded.feed, ticker: encoded.ticker, token, owned: !options.repairFenceToken });
      }
      if (encoded.feed === "yahoo-eod") {
        try {
          // Claim the correction fence first. A losing concurrent writer must
          // not leave a fresh unpointed payload on every retry.
          const usage = await reserveYahooArchiveBlock(db, encoded);
          rowsRead += usage.rowsRead;
          rowsWritten += usage.rowsWritten;
        } catch (error) {
          const fence = fences.get(security);
          // A full slot check has changed no archive data or revision clock.
          // Release only our fence; actual storage failures remain recoverable
          // through the existing pending-repair path.
          if (error instanceof EodFallbackStorageFullError && fence?.owned) {
            const closed = await marketDb.prepare(`UPDATE eod_adjustment_repairs SET status='complete',owner_token=NULL,updated_at=?
              WHERE feed=? AND ticker=? AND status='pending' AND owner_token=? RETURNING feed,ticker`)
              .bind(new Date().toISOString(), fence.feed, fence.ticker, fence.token).all<{ feed: string; ticker: string }>();
            if (closed.results.length !== 1 || closed.results[0].feed !== fence.feed || closed.results[0].ticker !== fence.ticker) {
              fail("Archive repair fence changed before capacity rejection.");
            }
            fences.delete(security);
          }
          throw error;
        }
      }
      // Cross-D1 publication is protected by the market-side pending fence. Revisions
      // on both sides of the move invalidate computations that started before it.
      await bumpRevision(encoded.feed, encoded.ticker, encoded.lastDate);
      await decodeMarketHistoryBlock(encoded);
      const write = await db.prepare(
        `INSERT OR IGNORE INTO market_history_blocks
          (id, feed, ticker, calendar_year, schema_version, codec, checksum, row_count,
           first_date, last_date, uncompressed_bytes, payload_base64)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(encoded.id, encoded.feed, encoded.ticker, encoded.calendarYear, encoded.schemaVersion, encoded.codec,
        encoded.checksum, encoded.rowCount, encoded.firstDate, encoded.lastDate, encoded.uncompressedBytes, encoded.payloadBase64).run();
      rowsRead += Number(write.meta?.rows_read ?? 0);
      rowsWritten += Number(write.meta?.rows_written ?? write.meta?.changes ?? 0);
      const stored = await db.prepare(`SELECT ${BLOCK_COLUMNS} FROM market_history_blocks b WHERE b.id = ?`)
        .bind(encoded.id).first<MarketHistoryBlock>();
      rowsRead += 1;
      if (!stored) fail("Archive block was not readable after its write.");
      await decodeMarketHistoryBlock(stored);
      if (stored.checksum !== encoded.checksum) fail("Archive read-back checksum differs from the submitted block.");
      const verifiedAt = new Date().toISOString();
      const promoted = await db.batch<{ block_id: string }>([
        db.prepare("UPDATE market_history_blocks SET verified_at = ? WHERE id = ? AND checksum = ?")
          .bind(verifiedAt, encoded.id, encoded.checksum),
        db.prepare(`INSERT INTO market_history_block_pointers (feed, ticker, calendar_year, block_id, updated_at)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(feed, ticker, calendar_year) DO UPDATE SET
            previous_block_id = market_history_block_pointers.block_id,
            block_id = excluded.block_id, updated_at = excluded.updated_at
          WHERE market_history_block_pointers.block_id = ? RETURNING block_id`)
          .bind(encoded.feed, encoded.ticker, encoded.calendarYear, encoded.id, verifiedAt, current[0]?.id ?? null),
      ]);
      for (const result of promoted) {
        rowsRead += Number(result.meta?.rows_read ?? 0);
        rowsWritten += Number(result.meta?.rows_written ?? result.meta?.changes ?? 0);
      }
      if (promoted[1].results.length !== 1 || promoted[1].results[0].block_id !== encoded.id) {
        fail("Archive changed concurrently; retry this security/year before pruning any hot rows.");
      }
      await bumpRevision(encoded.feed, encoded.ticker, encoded.lastDate);
      // Bound storage to the active and immediately preceding verified revision.
      const obsolete = current[0]?.previousBlockId;
      if (obsolete && obsolete !== encoded.id && obsolete !== current[0]?.id) {
        const deleted = await db.prepare(`DELETE FROM market_history_blocks WHERE id = ?
          AND NOT EXISTS (SELECT 1 FROM market_history_block_pointers
            WHERE feed = ? AND ticker = ? AND calendar_year = ? AND (block_id = ? OR previous_block_id = ?))`)
          .bind(obsolete, encoded.feed, encoded.ticker, encoded.calendarYear, obsolete, obsolete).run();
        rowsRead += Number(deleted.meta?.rows_read ?? 0);
        rowsWritten += Number(deleted.meta?.rows_written ?? deleted.meta?.changes ?? 0);
      }
      const { payloadBase64: _payload, ...manifest } = encoded;
      manifests.push({ ...manifest, verifiedAt });
    }
    completed = true;
  } finally {
    // A failed identical storage copy leaves all prices hot. Release only its
    // own fence so a retry does not require an unrelated financial repair.
    // Genuine archive corrections retain a failed fence until explicit repair.
    if (completed || options.verifiedHotRelocation) {
      for (const fence of fences.values()) if (fence.owned) {
        const closed = await marketDb.prepare(`UPDATE eod_adjustment_repairs SET status='complete',owner_token=NULL,updated_at=?
          WHERE feed=? AND ticker=? AND status='pending' AND owner_token=? RETURNING feed,ticker`)
          .bind(new Date().toISOString(), fence.feed, fence.ticker, fence.token).all<{ feed: string; ticker: string }>();
        rowsRead += Number(closed.meta?.rows_read ?? 0);
        rowsWritten += Number(closed.meta?.rows_written ?? closed.meta?.changes ?? 0);
        if (closed.results.length !== 1 || closed.results[0].feed !== fence.feed || closed.results[0].ticker !== fence.ticker) {
          fail("Archive repair fence changed before completion.");
        }
      }
    }
  }
  return { blocks: manifests, rowsRead, rowsWritten, revisionChanges: Array.from(revisionChanges.values()) };
}
