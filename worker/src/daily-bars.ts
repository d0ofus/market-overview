import { getProvider, type DailyBar, type MarketDataProvider } from "./provider";
import type { Env } from "./types";

const BAR_QUERY_TICKER_CHUNK_SIZE = 80;
const BAR_WRITE_CHUNK_SIZE = 200;

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
): DailyBar[] {
  const byTickerDate = new Map<string, DailyBar>();
  for (const bar of bars) {
    const ticker = bar.ticker.toUpperCase();
    const latest = latestByTicker.get(ticker) ?? null;
    if (bar.date < desiredStartDate || bar.date > endDate) continue;
    if (latest && bar.date <= latest) continue;
    byTickerDate.set(`${ticker}|${bar.date}`, { ...bar, ticker });
  }
  return Array.from(byTickerDate.values());
}

export async function refreshDailyBarsIncremental(env: Env, input: {
  tickers: string[];
  startDate: string;
  endDate: string;
  maxTickers?: number;
  provider?: MarketDataProvider;
}): Promise<{ requestedTickers: number; fetchedRows: number; writtenRows: number; skippedCurrentTickers: number }> {
  const tickers = normalizeTickers(input.tickers, input.maxTickers);
  if (tickers.length === 0) {
    return { requestedTickers: 0, fetchedRows: 0, writtenRows: 0, skippedCurrentTickers: 0 };
  }

  const provider = input.provider ?? getProvider(env);
  const latestByTicker = await loadLatestBarDates(env, tickers);
  const grouped = groupTickersByRefreshStart(tickers, latestByTicker, input.startDate, input.endDate);
  const skippedCurrentTickers = tickers.length - Array.from(grouped.values()).reduce((sum, rows) => sum + rows.length, 0);
  const fetchedBars: DailyBar[] = [];

  for (const [startDate, groupTickers] of grouped) {
    const rows = await provider.getDailyBars(groupTickers, startDate, input.endDate);
    fetchedBars.push(...rows);
  }

  const barsToWrite = dedupeFetchedBars(fetchedBars, latestByTicker, input.startDate, input.endDate);
  if (barsToWrite.length > 0) {
    await ensureSymbolsExist(env, barsToWrite.map((bar) => bar.ticker));
    await runStatementsInChunks(
      env,
      barsToWrite.map((bar) =>
        env.DB.prepare(
          "INSERT OR REPLACE INTO daily_bars (ticker, date, o, h, l, c, volume) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).bind(bar.ticker.toUpperCase(), bar.date, bar.o, bar.h, bar.l, bar.c, bar.volume ?? 0),
      ),
    );
  }

  return {
    requestedTickers: tickers.length,
    fetchedRows: fetchedBars.length,
    writtenRows: barsToWrite.length,
    skippedCurrentTickers,
  };
}
