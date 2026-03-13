import { getProvider } from "./provider";
import { hasSharesOutstandingColumn } from "./peer-groups-service";
import type { Env } from "./types";

const SHARE_QUERY_CHUNK_SIZE = 50;

export type PeerMetricRow = {
  ticker: string;
  price: number | null;
  change1d: number | null;
  marketCap: number | null;
  avgVolume: number | null;
  asOf: string;
  source: string;
};

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export function buildPeerMetricRows(
  tickers: string[],
  asOf: string,
  snapshotRows: Record<string, { price: number; prevClose: number }>,
  recentBars: Array<{ ticker: string; date: string; c: number; volume: number }>,
  sharesByTicker: Map<string, number | null>,
): PeerMetricRow[] {
  const barsByTicker = new Map<string, number[]>();
  const closesByTicker = new Map<string, number[]>();
  for (const row of recentBars) {
    const ticker = row.ticker.toUpperCase();
    const current = barsByTicker.get(ticker) ?? [];
    current.push(Number(row.volume ?? 0));
    barsByTicker.set(ticker, current);

    const closes = closesByTicker.get(ticker) ?? [];
    closes.push(Number(row.c ?? 0));
    closesByTicker.set(ticker, closes);
  }

  return tickers.map((ticker) => {
    const latestSnapshot = snapshotRows[ticker];
    const closes = (closesByTicker.get(ticker) ?? []).filter((value) => Number.isFinite(value) && value > 0);
    const fallbackPrice = closes.at(-1);
    const fallbackPrevClose = closes.length >= 2 ? closes.at(-2) ?? null : null;
    const price = typeof latestSnapshot?.price === "number"
      ? latestSnapshot.price
      : typeof fallbackPrice === "number"
        ? fallbackPrice
        : null;
    const prevClose = typeof latestSnapshot?.prevClose === "number" && latestSnapshot.prevClose > 0
      ? latestSnapshot.prevClose
      : typeof fallbackPrevClose === "number" && fallbackPrevClose > 0
        ? fallbackPrevClose
        : null;
    const change1d = typeof price === "number" && typeof prevClose === "number" && prevClose > 0
      ? ((price - prevClose) / prevClose) * 100
      : null;
    const sharesOutstanding = sharesByTicker.get(ticker);
    const avgVolume = mean((barsByTicker.get(ticker) ?? []).slice(-30).filter((value) => Number.isFinite(value)));
    return {
      ticker,
      price,
      change1d,
      marketCap: typeof price === "number" && typeof sharesOutstanding === "number" ? price * sharesOutstanding : null,
      avgVolume,
      asOf,
      source: typeof price === "number" && typeof sharesOutstanding === "number" ? "alpaca+seeded-shares" : "alpaca",
    };
  });
}

export async function loadSharesOutstandingMap(env: Env, tickers: string[]): Promise<Map<string, number | null>> {
  const normalized = Array.from(new Set(tickers.map((ticker) => String(ticker ?? "").trim().toUpperCase()).filter(Boolean)));
  if (normalized.length === 0) return new Map();

  const sharesOutstandingColumn = await hasSharesOutstandingColumn(env);
  if (!sharesOutstandingColumn) return new Map();

  const rows = await Promise.all(
    chunk(normalized, SHARE_QUERY_CHUNK_SIZE).map(async (tickerChunk) => {
      const result = await env.DB.prepare(
        `SELECT ticker, shares_outstanding as sharesOutstanding FROM symbols WHERE ticker IN (${tickerChunk.map(() => "?").join(",")})`,
      )
        .bind(...tickerChunk)
        .all<{ ticker: string; sharesOutstanding: number | null }>();
      return result.results ?? [];
    }),
  );

  return new Map(
    rows.flat().map((row) => [String(row.ticker ?? "").toUpperCase(), row.sharesOutstanding]),
  );
}

export async function loadPeerMetrics(env: Env, tickersInput: string[]): Promise<{ rows: PeerMetricRow[]; error: string | null }> {
  const tickers = Array.from(new Set(tickersInput.map((ticker) => String(ticker ?? "").trim().toUpperCase()).filter(Boolean)));
  if (tickers.length === 0) return { rows: [], error: null };

  const asOf = new Date().toISOString();
  const errorMessages: string[] = [];
  let snapshotRows: Record<string, { price: number; prevClose: number }> = {};
  let recentBars: Array<{ ticker: string; date: string; c: number; volume: number }> = [];
  let sharesByTicker = new Map<string, number | null>();

  try {
    const provider = getProvider(env);
    const end = asOf.slice(0, 10);
    const start = new Date(Date.now() - 60 * 86400_000).toISOString().slice(0, 10);
    const [snapshots, bars] = await Promise.all([
      provider.getQuoteSnapshot ? provider.getQuoteSnapshot(tickers) : Promise.resolve({}),
      provider.getDailyBars(tickers, start, end),
    ]);
    snapshotRows = snapshots;
    recentBars = bars.map((row) => ({ ...row, ticker: row.ticker.toUpperCase(), volume: Number(row.volume ?? 0) }));
  } catch (error) {
    errorMessages.push(error instanceof Error ? error.message : "Failed to load Alpaca metrics.");
  }

  try {
    sharesByTicker = await loadSharesOutstandingMap(env, tickers);
  } catch (error) {
    errorMessages.push(error instanceof Error ? error.message : "Failed to load seeded share counts.");
  }

  return {
    rows: buildPeerMetricRows(tickers, asOf, snapshotRows, recentBars, sharesByTicker),
    error: errorMessages.length > 0 ? errorMessages.join(" | ") : null,
  };
}
