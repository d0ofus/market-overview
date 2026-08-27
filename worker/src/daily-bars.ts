import { getProvider, type DailyBar, type MarketDataProvider } from "./provider";
import {
  assertMarketDataCapacity,
  assertMarketDataWriteBudget,
  getMarketDataDb,
  inspectMarketDataSize,
  marketDataFeed,
  recordMarketDataD1Usage,
} from "./market-data-db";
import type { Env } from "./types";

const BAR_QUERY_TICKER_CHUNK_SIZE = 80;
const BAR_WRITE_CHUNK_SIZE = 200;
const DEFAULT_PROVIDER_BATCH_SIZE = 80;
const YAHOO_REPAIR_FEED = "repair-yahoo";

export type DailyBarStorageTarget = "market";

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
): Promise<{ changes: number; rowsRead: number; rowsWritten: number }> {
  const usage = { changes: 0, rowsRead: 0, rowsWritten: 0 };
  for (let index = 0; index < statements.length; index += chunkSize) {
    const chunk = statements.slice(index, index + chunkSize);
    if (chunk.length === 0) continue;
    const results = await db.batch(chunk);
    for (const result of results) {
      usage.changes += Number(result.meta?.changes ?? 0);
      usage.rowsRead += Number(result.meta?.rows_read ?? 0);
      usage.rowsWritten += Number(result.meta?.rows_written ?? result.meta?.changes ?? 0);
      if (inspectCapacity) inspectMarketDataSize(env, result.meta?.size_after);
    }
  }
  return usage;
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
  void target;
  const db = getMarketDataDb(env);
  for (let index = 0; index < tickers.length; index += BAR_QUERY_TICKER_CHUNK_SIZE) {
    const chunk = tickers.slice(index, index + BAR_QUERY_TICKER_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const sql = `SELECT ticker, MAX(date) as lastDate FROM alpaca_daily_bars WHERE feed = ? AND ticker IN (${placeholders}) GROUP BY ticker`;
    const rows = await db.prepare(sql)
      .bind(feed, ...chunk)
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
  void target;
  const db = getMarketDataDb(env);
  for (let index = 0; index < tickers.length; index += BAR_QUERY_TICKER_CHUNK_SIZE) {
    const chunk = tickers.slice(index, index + BAR_QUERY_TICKER_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const sql = `SELECT ticker FROM alpaca_daily_bars WHERE feed = ? AND ticker IN (${placeholders}) AND date = ?`;
    const rows = await db.prepare(sql)
      .bind(feed, ...chunk, date)
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
  _latestByTicker: Map<string, string | null>,
  desiredStartDate: string,
  endDate: string,
): DailyBar[] {
  const byTickerDate = new Map<string, DailyBar>();
  for (const bar of bars) {
    const ticker = bar.ticker.toUpperCase();
    if (bar.date < desiredStartDate || bar.date > endDate) continue;
    byTickerDate.set(`${ticker}|${bar.date}`, { ...bar, ticker });
  }
  return Array.from(byTickerDate.values());
}

function dedupeMarketRepairBars(
  bars: DailyBar[],
  desiredStartDate: string,
  endDate: string,
): DailyBar[] {
  const byTickerDate = new Map<string, DailyBar>();
  for (const bar of bars) {
    const ticker = bar.ticker.toUpperCase();
    if (bar.date < desiredStartDate || bar.date > endDate) continue;
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
  repairMissingMarketDates = false,
): Promise<number> {
  const strictProviderRequired = /^(1|true|yes|on)$/i.test(String(env.MARKET_DATA_DB_REQUIRED ?? "").trim());
  if (target === "market" && strictProviderRequired && sourceProvider !== "alpaca") {
    throw new Error(`The strict market-data store only accepts Alpaca bars, not ${sourceProvider}.`);
  }
  const unexpectedProviders = target === "market"
    ? Array.from(new Set(bars.map((bar) => bar.sourceProvider).filter((provider): provider is string => Boolean(provider && provider !== "alpaca"))))
    : [];
  const invalidRepairProvider = unexpectedProviders.find((provider) => !repairMissingMarketDates || provider !== "yahoo");
  if (invalidRepairProvider && strictProviderRequired) {
    throw new Error(`The strict market-data store rejected ${invalidRepairProvider} fallback bars.`);
  }
  const barsToWrite = repairMissingMarketDates
    ? dedupeMarketRepairBars(bars, startDate, endDate)
    : dedupeMarketBars(bars, latestByTicker, startDate, endDate);
  if (barsToWrite.length === 0) return 0;
  void replaceExisting;
  const db = getMarketDataDb(env);
  const writeUsage = await runStatementsInChunks(
    env,
    db,
    barsToWrite.map((bar) =>
      db.prepare(
           `INSERT INTO alpaca_daily_bars
             (feed, ticker, date, o, h, l, c, volume, fetched_at, source_provider, adjustment, observed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?)
           ON CONFLICT(feed, ticker, date) DO UPDATE SET
             o = excluded.o,
             h = excluded.h,
             l = excluded.l,
             c = excluded.c,
             volume = excluded.volume,
             fetched_at = excluded.fetched_at,
             source_provider = excluded.source_provider,
             adjustment = excluded.adjustment,
             observed_at = excluded.observed_at
           WHERE NOT (
             alpaca_daily_bars.source_provider = 'alpaca'
             AND excluded.source_provider <> 'alpaca'
           )
             AND (
               alpaca_daily_bars.o IS NOT excluded.o
               OR alpaca_daily_bars.h IS NOT excluded.h
               OR alpaca_daily_bars.l IS NOT excluded.l
               OR alpaca_daily_bars.c IS NOT excluded.c
               OR alpaca_daily_bars.volume IS NOT excluded.volume
               OR alpaca_daily_bars.source_provider IS NOT excluded.source_provider
               OR alpaca_daily_bars.adjustment IS NOT excluded.adjustment
             )`,
        ).bind(
          (bar.sourceProvider ?? sourceProvider) === "yahoo"
            ? YAHOO_REPAIR_FEED
            : bar.sourceFeed ?? sourceFeed ?? marketDataFeed(env),
          bar.ticker.toUpperCase(),
          bar.date,
          bar.o,
          bar.h,
          bar.l,
          bar.c,
          bar.volume ?? 0,
          bar.sourceProvider ?? sourceProvider,
          env.ALPACA_DAILY_ADJUSTMENT ?? "split",
          bar.observedAt ?? `${bar.date}T23:59:59Z`,
        ),
    ),
    BAR_WRITE_CHUNK_SIZE,
    true,
  );
  let invalidationUsage = { changes: 0, rowsRead: 0, rowsWritten: 0 };
  if (writeUsage.changes > 0) {
    const earliestChangedDateByTicker = new Map<string, string>();
    for (const bar of barsToWrite) {
      const ticker = bar.ticker.toUpperCase();
      const current = earliestChangedDateByTicker.get(ticker);
      if (!current || bar.date < current) earliestChangedDateByTicker.set(ticker, bar.date);
    }
    invalidationUsage = await runStatementsInChunks(
      env,
      db,
      Array.from(earliestChangedDateByTicker, ([ticker, changedDate]) => db.prepare(
        `DELETE FROM daily_market_features
          WHERE feed = ? AND ticker = ? AND session_date >= ?`,
      ).bind(marketDataFeed(env), ticker, changedDate)),
      BAR_WRITE_CHUNK_SIZE,
      true,
    );
  }
  for (const bar of barsToWrite) {
    const ticker = bar.ticker.toUpperCase();
    const latest = latestByTicker.get(ticker);
    if (!latest || bar.date > latest) latestByTicker.set(ticker, bar.date);
  }
  await recordMarketDataD1Usage(env, {
    barsChanged: writeUsage.changes,
    rowsRead: writeUsage.rowsRead + invalidationUsage.rowsRead,
    rowsWritten: writeUsage.rowsWritten + invalidationUsage.rowsWritten,
  });
  return writeUsage.changes;
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
  repairMissingMarketDates?: boolean;
}): Promise<{
  requestedTickers: number;
  fetchedRows: number;
  writtenRows: number;
  skippedCurrentTickers: number;
  currentDateTickers: number;
  missingCurrentDateTickers: number;
  currentDateCoveragePct: number;
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
    };
  }

  const provider = input.provider ?? getProvider(env);
  const sourceProvider = (env.DATA_PROVIDER ?? "alpaca").trim().toLowerCase() || "alpaca";
  const sourceFeed = sourceProvider === "alpaca"
    ? (env.ALPACA_DAILY_FEED ?? env.ALPACA_FEED ?? "iex").trim().toLowerCase() || "iex"
    : null;
  const target = input.target ?? "market";
  const feed = sourceFeed ?? marketDataFeed(env);
  const latestByTicker = await loadLatestBarDates(env, tickers, target, feed);
  const grouped = input.replaceExisting || input.repairMissingMarketDates
    ? new Map([[input.startDate, tickers]])
    : groupTickersByRefreshStart(tickers, latestByTicker, input.startDate, input.endDate);
  const skippedCurrentTickers = input.replaceExisting
    ? 0
    : tickers.length - Array.from(grouped.values()).reduce((sum, rows) => sum + rows.length, 0);
  let fetchedRows = 0;
  let writtenRows = 0;
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
          input.repairMissingMarketDates ?? false,
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
  };
}
