import { getProvider, type DailyBar, type MarketDataProvider } from "./provider";
import type { Env } from "./types";

const BAR_QUERY_TICKER_CHUNK_SIZE = 80;
const BAR_WRITE_CHUNK_SIZE = 200;
const DEFAULT_PROVIDER_BATCH_SIZE = 80;

function addUtcDays(isoDate: string, days: number): string {
  const parsed = new Date(`${isoDate}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function normalizeTickers(tickers: string[], maxTickers?: number): string[] {
  const unique = Array.from(new Set(tickers.map((ticker) => ticker.toUpperCase()).filter(Boolean)));
  return typeof maxTickers === "number" ? unique.slice(0, Math.max(1, maxTickers)) : unique;
}

async function runStatementsInChunks(env: Env, statements: D1PreparedStatement[], chunkSize = BAR_WRITE_CHUNK_SIZE): Promise<void> {
  for (let index = 0; index < statements.length; index += chunkSize) {
    const chunk = statements.slice(index, index + chunkSize);
    if (chunk.length === 0) continue;
    await env.DB.batch(chunk);
  }
}

async function ensureSymbolsExist(env: Env, tickers: string[]): Promise<void> {
  const unique = normalizeTickers(tickers);
  if (unique.length === 0) return;
  const statements = unique.map((ticker) =>
    env.DB.prepare("INSERT OR IGNORE INTO symbols (ticker, name, asset_class) VALUES (?, ?, ?)")
      .bind(ticker, ticker, "equity"),
  );
  await runStatementsInChunks(env, statements);
}

function chunkTickers(tickers: string[], chunkSize: number): string[][] {
  const size = Math.max(1, Math.trunc(chunkSize));
  const chunks: string[][] = [];
  for (let index = 0; index < tickers.length; index += size) {
    chunks.push(tickers.slice(index, index + size));
  }
  return chunks;
}

async function loadLatestBarDates(env: Env, tickers: string[]): Promise<Map<string, string | null>> {
  const latestByTicker = new Map<string, string | null>();
  for (let index = 0; index < tickers.length; index += BAR_QUERY_TICKER_CHUNK_SIZE) {
    const chunk = tickers.slice(index, index + BAR_QUERY_TICKER_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT ticker, MAX(date) as lastDate FROM daily_bars WHERE ticker IN (${placeholders}) GROUP BY ticker`,
    )
      .bind(...chunk)
      .all<{ ticker: string; lastDate: string | null }>();
    for (const row of rows.results ?? []) {
      latestByTicker.set(row.ticker.toUpperCase(), row.lastDate ?? null);
    }
  }
  return latestByTicker;
}

async function loadTickersWithBarOnDate(env: Env, tickers: string[], date: string): Promise<Set<string>> {
  const tickersWithBar = new Set<string>();
  for (let index = 0; index < tickers.length; index += BAR_QUERY_TICKER_CHUNK_SIZE) {
    const chunk = tickers.slice(index, index + BAR_QUERY_TICKER_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT DISTINCT ticker FROM daily_bars WHERE ticker IN (${placeholders}) AND date = ?`,
    )
      .bind(...chunk, date)
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

async function writeFetchedDailyBars(
  env: Env,
  bars: DailyBar[],
  latestByTicker: Map<string, string | null>,
  startDate: string,
  endDate: string,
  replaceExisting: boolean,
): Promise<number> {
  const barsToWrite = dedupeFetchedBars(bars, latestByTicker, startDate, endDate, replaceExisting);
  if (barsToWrite.length === 0) return 0;
  await ensureSymbolsExist(env, barsToWrite.map((bar) => bar.ticker));
  await runStatementsInChunks(
    env,
    barsToWrite.map((bar) =>
      env.DB.prepare(
        "INSERT OR REPLACE INTO daily_bars (ticker, date, o, h, l, c, volume) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(bar.ticker.toUpperCase(), bar.date, bar.o, bar.h, bar.l, bar.c, bar.volume ?? 0),
    ),
  );
  for (const bar of barsToWrite) {
    const ticker = bar.ticker.toUpperCase();
    const latest = latestByTicker.get(ticker);
    if (!latest || bar.date > latest) latestByTicker.set(ticker, bar.date);
  }
  return barsToWrite.length;
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
  const latestByTicker = await loadLatestBarDates(env, tickers);
  const grouped = input.replaceExisting
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
        const rows = await provider.getDailyBars(chunk, startDate, input.endDate);
        fetchedRows += rows.length;
        writtenRows += await writeFetchedDailyBars(
          env,
          rows,
          latestByTicker,
          input.startDate,
          input.endDate,
          input.replaceExisting ?? false,
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

  const tickersWithEndDateBar = await loadTickersWithBarOnDate(env, tickers, input.endDate);
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
