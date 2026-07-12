import { getProvider, type DailyBar, type MarketDataProvider } from "./provider";
import {
  assertMarketDataCapacity,
  assertMarketDataWriteBudget,
  getMarketDataDb,
  inspectMarketDataSize,
  marketDataFeed,
  marketDataRetentionCutoff,
  recordMarketDataBarsWritten,
} from "./market-data-db";
import type { Env } from "./types";

const BAR_QUERY_TICKER_CHUNK_SIZE = 80;
const BAR_WRITE_CHUNK_SIZE = 200;
const DEFAULT_PROVIDER_BATCH_SIZE = 80;

export type DailyBarStorageTarget = "legacy" | "market";

function addUtcDays(isoDate: string, days: number): string {
  const parsed = new Date(`${isoDate}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function normalizeTickers(tickers: string[], maxTickers?: number): string[] {
  const unique = Array.from(new Set(tickers.map((ticker) => ticker.toUpperCase()).filter(Boolean)));
  return typeof maxTickers === "number" ? unique.slice(0, Math.max(1, maxTickers)) : unique;
}

async function runStatementsInChunks(
  env: Env,
  db: D1Database,
  statements: D1PreparedStatement[],
  chunkSize = BAR_WRITE_CHUNK_SIZE,
  inspectCapacity = false,
): Promise<void> {
  for (let index = 0; index < statements.length; index += chunkSize) {
    const chunk = statements.slice(index, index + chunkSize);
    if (chunk.length === 0) continue;
    const results = await db.batch(chunk);
    if (inspectCapacity) {
      for (const result of results) inspectMarketDataSize(env, result.meta?.size_after);
    }
  }
}

async function ensureSymbolsExist(env: Env, tickers: string[]): Promise<void> {
  const unique = normalizeTickers(tickers);
  if (unique.length === 0) return;
  const statements = unique.map((ticker) =>
    env.DB.prepare("INSERT OR IGNORE INTO symbols (ticker, name, asset_class) VALUES (?, ?, ?)")
      .bind(ticker, ticker, "equity"),
  );
  await runStatementsInChunks(env, env.DB, statements);
}

function chunkTickers(tickers: string[], chunkSize: number): string[][] {
  const size = Math.max(1, Math.trunc(chunkSize));
  const chunks: string[][] = [];
  for (let index = 0; index < tickers.length; index += size) {
    chunks.push(tickers.slice(index, index + size));
  }
  return chunks;
}

async function loadLatestBarDates(
  env: Env,
  tickers: string[],
  target: DailyBarStorageTarget,
  feed: string,
): Promise<Map<string, string | null>> {
  const latestByTicker = new Map<string, string | null>();
  const db = target === "market" ? getMarketDataDb(env) : env.DB;
  for (let index = 0; index < tickers.length; index += BAR_QUERY_TICKER_CHUNK_SIZE) {
    const chunk = tickers.slice(index, index + BAR_QUERY_TICKER_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const sql = target === "market"
      ? `SELECT ticker, MAX(date) as lastDate FROM alpaca_daily_bars WHERE feed = ? AND ticker IN (${placeholders}) GROUP BY ticker`
      : `SELECT ticker, MAX(date) as lastDate FROM daily_bars WHERE ticker IN (${placeholders}) GROUP BY ticker`;
    const rows = await db.prepare(sql)
      .bind(...(target === "market" ? [feed, ...chunk] : chunk))
      .all<{ ticker: string; lastDate: string | null }>();
    for (const row of rows.results ?? []) {
      latestByTicker.set(row.ticker.toUpperCase(), row.lastDate ?? null);
    }
  }
  return latestByTicker;
}

async function loadTickersWithBarOnDate(
  env: Env,
  tickers: string[],
  date: string,
  target: DailyBarStorageTarget,
  feed: string,
): Promise<Set<string>> {
  const tickersWithBar = new Set<string>();
  const db = target === "market" ? getMarketDataDb(env) : env.DB;
  for (let index = 0; index < tickers.length; index += BAR_QUERY_TICKER_CHUNK_SIZE) {
    const chunk = tickers.slice(index, index + BAR_QUERY_TICKER_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const sql = target === "market"
      ? `SELECT ticker FROM alpaca_daily_bars WHERE feed = ? AND ticker IN (${placeholders}) AND date = ?`
      : `SELECT DISTINCT ticker FROM daily_bars WHERE ticker IN (${placeholders}) AND date = ?`;
    const rows = await db.prepare(sql)
      .bind(...(target === "market" ? [feed, ...chunk, date] : [...chunk, date]))
      .all<{ ticker: string }>();
    for (const row of rows.results ?? []) {
      tickersWithBar.add(row.ticker.toUpperCase());
    }
  }
  return tickersWithBar;
}

function groupTickersByRefreshStart(
  tickers: string[],
  latestByTicker: Map<string, string | null>,
  desiredStartDate: string,
  endDate: string,
): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const ticker of tickers) {
    const latest = latestByTicker.get(ticker) ?? null;
    const nextMissingDate = latest ? addUtcDays(latest, 1) : null;
    const start = nextMissingDate && nextMissingDate > desiredStartDate ? nextMissingDate : desiredStartDate;
    if (start > endDate) continue;
    const rows = grouped.get(start) ?? [];
    rows.push(ticker);
    grouped.set(start, rows);
  }
  return grouped;
}

function dedupeFetchedBars(
  bars: DailyBar[],
  latestByTicker: Map<string, string | null>,
  desiredStartDate: string,
  endDate: string,
  replaceExisting = false,
): DailyBar[] {
  const byTickerDate = new Map<string, DailyBar>();
  for (const bar of bars) {
    const ticker = bar.ticker.toUpperCase();
    const latest = latestByTicker.get(ticker) ?? null;
    if (bar.date < desiredStartDate || bar.date > endDate) continue;
    if (!replaceExisting && latest && bar.date <= latest) continue;
    byTickerDate.set(`${ticker}|${bar.date}`, { ...bar, ticker });
  }
  return Array.from(byTickerDate.values());
}

function dedupeMarketBars(
  bars: DailyBar[],
  latestByTicker: Map<string, string | null>,
  desiredStartDate: string,
  endDate: string,
): DailyBar[] {
  const byTickerDate = new Map<string, DailyBar>();
  for (const bar of bars) {
    const ticker = bar.ticker.toUpperCase();
    const latest = latestByTicker.get(ticker) ?? null;
    if (bar.date < desiredStartDate || bar.date > endDate) continue;
    if (latest && bar.date <= latest && bar.date !== endDate) continue;
    byTickerDate.set(`${ticker}|${bar.date}`, { ...bar, ticker });
  }
  return Array.from(byTickerDate.values());
}

async function writeFetchedDailyBars(
  env: Env,
  bars: DailyBar[],
  latestByTicker: Map<string, string | null>,
  startDate: string,
  endDate: string,
  replaceExisting: boolean,
  sourceProvider: string,
  sourceFeed: string | null,
  target: DailyBarStorageTarget,
): Promise<number> {
  const strictProviderRequired = /^(1|true|yes|on)$/i.test(String(env.MARKET_DATA_DB_REQUIRED ?? "").trim());
  if (target === "market" && strictProviderRequired && sourceProvider !== "alpaca") {
    throw new Error(`The strict market-data store only accepts Alpaca bars, not ${sourceProvider}.`);
  }
  const unexpectedProvider = target === "market"
    ? bars.find((bar) => bar.sourceProvider && bar.sourceProvider !== "alpaca")?.sourceProvider
    : null;
  if (unexpectedProvider && strictProviderRequired) {
    throw new Error(`The strict market-data store rejected ${unexpectedProvider} fallback bars.`);
  }
  const barsToWrite = target === "market"
    ? dedupeMarketBars(bars, latestByTicker, startDate, endDate)
    : dedupeFetchedBars(bars, latestByTicker, startDate, endDate, replaceExisting);
  if (barsToWrite.length === 0) return 0;
  const db = target === "market" ? getMarketDataDb(env) : env.DB;
  if (target === "legacy") await ensureSymbolsExist(env, barsToWrite.map((bar) => bar.ticker));
  await runStatementsInChunks(
    env,
    db,
    barsToWrite.map((bar) =>
      target === "market"
        ? db.prepare(
          `INSERT INTO alpaca_daily_bars
             (feed, ticker, date, o, h, l, c, volume, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(feed, ticker, date) DO UPDATE SET
             o = excluded.o,
             h = excluded.h,
             l = excluded.l,
             c = excluded.c,
             volume = excluded.volume,
             fetched_at = excluded.fetched_at`,
        ).bind(
          bar.sourceFeed ?? sourceFeed ?? marketDataFeed(env),
          bar.ticker.toUpperCase(),
          bar.date,
          bar.o,
          bar.h,
          bar.l,
          bar.c,
          bar.volume ?? 0,
        )
        : db.prepare(
          `INSERT INTO daily_bars
           (ticker, date, o, h, l, c, volume, source_provider, source_feed, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(ticker, date) DO UPDATE SET
           o = excluded.o,
           h = excluded.h,
           l = excluded.l,
           c = excluded.c,
           volume = excluded.volume,
           source_provider = excluded.source_provider,
           source_feed = excluded.source_feed,
           fetched_at = excluded.fetched_at
         WHERE excluded.source_provider = 'alpaca'
            OR COALESCE(daily_bars.source_provider, '') <> 'alpaca'`,
        ).bind(
          bar.ticker.toUpperCase(),
          bar.date,
          bar.o,
          bar.h,
          bar.l,
          bar.c,
          bar.volume ?? 0,
          bar.sourceProvider ?? sourceProvider,
          bar.sourceProvider
            ? bar.sourceProvider === sourceProvider
              ? bar.sourceFeed ?? sourceFeed
              : bar.sourceFeed ?? null
            : sourceFeed,
        ),
    ),
    BAR_WRITE_CHUNK_SIZE,
    target === "market",
  );
  for (const bar of barsToWrite) {
    const ticker = bar.ticker.toUpperCase();
    const latest = latestByTicker.get(ticker);
    if (!latest || bar.date > latest) latestByTicker.set(ticker, bar.date);
  }
  if (target === "market") await recordMarketDataBarsWritten(env, barsToWrite.length);
  return barsToWrite.length;
}

async function pruneMarketBars(env: Env, tickers: string[], feed: string, asOfDate: string): Promise<void> {
  const db = getMarketDataDb(env);
  const cutoff = marketDataRetentionCutoff(env, asOfDate);
  for (const tickerChunk of chunkTickers(normalizeTickers(tickers), BAR_QUERY_TICKER_CHUNK_SIZE)) {
    const placeholders = tickerChunk.map(() => "?").join(",");
    const result = await db.prepare(
      `DELETE FROM alpaca_daily_bars WHERE feed = ? AND ticker IN (${placeholders}) AND date < ?`,
    ).bind(feed, ...tickerChunk, cutoff).run();
    inspectMarketDataSize(env, result.meta?.size_after);
    await recordMarketDataBarsWritten(env, Number(result.meta?.changes ?? 0));
  }
}

async function loadMarketBarsOnDate(env: Env, tickers: string[], feed: string, date: string): Promise<DailyBar[]> {
  const rows: DailyBar[] = [];
  for (const tickerChunk of chunkTickers(normalizeTickers(tickers), BAR_QUERY_TICKER_CHUNK_SIZE)) {
    const placeholders = tickerChunk.map(() => "?").join(",");
    const result = await getMarketDataDb(env).prepare(
      `SELECT ticker, date, o, h, l, c, volume
       FROM alpaca_daily_bars
       WHERE feed = ? AND date = ? AND ticker IN (${placeholders})`,
    ).bind(feed, date, ...tickerChunk).all<DailyBar>();
    rows.push(...(result.results ?? []).map((bar) => ({
      ...bar,
      sourceProvider: "alpaca",
      sourceFeed: feed,
    })));
  }
  return rows;
}

export async function refreshDailyBarsIncremental(env: Env, input: {
  tickers: string[];
  startDate: string;
  endDate: string;
  maxTickers?: number;
  provider?: MarketDataProvider;
  replaceExisting?: boolean;
  providerBatchSize?: number;
  continueOnError?: boolean;
  target?: DailyBarStorageTarget;
  mirrorLatestToLegacy?: boolean;
}): Promise<{
  requestedTickers: number;
  fetchedRows: number;
  writtenRows: number;
  skippedCurrentTickers: number;
  currentDateTickers: number;
  missingCurrentDateTickers: number;
  currentDateCoveragePct: number;
  mirroredRows?: number;
}> {
  const tickers = normalizeTickers(input.tickers, input.maxTickers);
  if (tickers.length === 0) {
    return {
      requestedTickers: 0,
      fetchedRows: 0,
      writtenRows: 0,
      skippedCurrentTickers: 0,
      currentDateTickers: 0,
      missingCurrentDateTickers: 0,
      currentDateCoveragePct: 0,
      mirroredRows: 0,
    };
  }

  const provider = input.provider ?? getProvider(env);
  const sourceProvider = (env.DATA_PROVIDER ?? "alpaca").trim().toLowerCase() || "alpaca";
  const sourceFeed = sourceProvider === "alpaca"
    ? (env.ALPACA_FEED ?? "iex").trim().toLowerCase() || "iex"
    : null;
  const target = input.target ?? "legacy";
  const feed = sourceFeed ?? marketDataFeed(env);
  const latestByTicker = await loadLatestBarDates(env, tickers, target, feed);
  const grouped = input.replaceExisting
    ? new Map([[input.startDate, tickers]])
    : groupTickersByRefreshStart(tickers, latestByTicker, input.startDate, input.endDate);
  const skippedCurrentTickers = input.replaceExisting
    ? 0
    : tickers.length - Array.from(grouped.values()).reduce((sum, rows) => sum + rows.length, 0);
  let fetchedRows = 0;
  let writtenRows = 0;
  let mirroredRows = 0;
  const providerBatchSize = Math.max(1, Math.trunc(input.providerBatchSize ?? DEFAULT_PROVIDER_BATCH_SIZE));

  for (const [startDate, groupTickers] of grouped) {
    for (const chunk of chunkTickers(groupTickers, providerBatchSize)) {
      try {
        if (target === "market") {
          await assertMarketDataWriteBudget(env);
          await assertMarketDataCapacity(env);
        }
        const rows = await provider.getDailyBars(chunk, startDate, input.endDate);
        fetchedRows += rows.length;
        writtenRows += await writeFetchedDailyBars(
          env,
          rows,
          latestByTicker,
          input.startDate,
          input.endDate,
          input.replaceExisting ?? false,
          sourceProvider,
          sourceFeed,
          target,
        );
      } catch (error) {
        if (!input.continueOnError) throw error;
        console.warn("daily bars provider chunk failed", {
          tickers: chunk,
          startDate,
          endDate: input.endDate,
          error,
        });
      }
    }
  }

  if (target === "market" && input.mirrorLatestToLegacy) {
    const latestRows = await loadMarketBarsOnDate(env, tickers, feed, input.endDate);
    mirroredRows = await writeFetchedDailyBars(
      env,
      latestRows,
      new Map<string, string | null>(),
      input.endDate,
      input.endDate,
      true,
      sourceProvider,
      sourceFeed,
      "legacy",
    );
  }
  if (target === "market") await pruneMarketBars(env, tickers, feed, input.endDate);
  const tickersWithEndDateBar = await loadTickersWithBarOnDate(env, tickers, input.endDate, target, feed);
  const currentDateTickers = tickersWithEndDateBar.size;
  const missingCurrentDateTickers = Math.max(0, tickers.length - currentDateTickers);

  return {
    requestedTickers: tickers.length,
    fetchedRows,
    writtenRows,
    skippedCurrentTickers,
    currentDateTickers,
    missingCurrentDateTickers,
    currentDateCoveragePct: tickers.length > 0 ? (currentDateTickers / tickers.length) * 100 : 0,
    mirroredRows,
  };
}
