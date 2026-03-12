import { getProvider } from "./provider";
import type { Env } from "./types";

export type PeerMetricRow = {
  ticker: string;
  price: number | null;
  marketCap: number | null;
  avgVolume: number | null;
  asOf: string;
  source: string;
};

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function buildPeerMetricRows(
  tickers: string[],
  asOf: string,
  snapshotRows: Record<string, { price: number; prevClose: number }>,
  recentBars: Array<{ ticker: string; date: string; c: number; volume: number }>,
  sharesByTicker: Map<string, number | null>,
): PeerMetricRow[] {
  const barsByTicker = new Map<string, number[]>();
  for (const row of recentBars) {
    const current = barsByTicker.get(row.ticker.toUpperCase()) ?? [];
    current.push(Number(row.volume ?? 0));
    barsByTicker.set(row.ticker.toUpperCase(), current);
  }

  return tickers.map((ticker) => {
    const latestSnapshot = snapshotRows[ticker];
    const fallbackPrice = recentBars.filter((row) => row.ticker.toUpperCase() === ticker).slice(-1)[0]?.c;
    const price = typeof latestSnapshot?.price === "number"
      ? latestSnapshot.price
      : typeof fallbackPrice === "number"
        ? fallbackPrice
        : null;
    const sharesOutstanding = sharesByTicker.get(ticker);
    const avgVolume = mean((barsByTicker.get(ticker) ?? []).slice(-30).filter((value) => Number.isFinite(value)));
    return {
      ticker,
      price,
      marketCap: typeof price === "number" && typeof sharesOutstanding === "number" ? price * sharesOutstanding : null,
      avgVolume,
      asOf,
      source: typeof price === "number" && typeof sharesOutstanding === "number" ? "alpaca+seeded-shares" : "alpaca",
    };
  });
}

export async function loadPeerMetrics(env: Env, tickersInput: string[]): Promise<{ rows: PeerMetricRow[]; error: string | null }> {
  const tickers = Array.from(new Set(tickersInput.map((ticker) => String(ticker ?? "").trim().toUpperCase()).filter(Boolean)));
  if (tickers.length === 0) return { rows: [], error: null };

  const asOf = new Date().toISOString();
  let providerError: string | null = null;
  let snapshotRows: Record<string, { price: number; prevClose: number }> = {};
  let recentBars: Array<{ ticker: string; date: string; c: number; volume: number }> = [];

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
    providerError = error instanceof Error ? error.message : "Failed to load Alpaca metrics.";
  }

  const shareRows = await env.DB.prepare(
    `SELECT ticker, shares_outstanding as sharesOutstanding FROM symbols WHERE ticker IN (${tickers.map(() => "?").join(",")})`,
  )
    .bind(...tickers)
    .all<{ ticker: string; sharesOutstanding: number | null }>();
  const sharesByTicker = new Map((shareRows.results ?? []).map((row) => [row.ticker.toUpperCase(), row.sharesOutstanding]));

  return {
    rows: buildPeerMetricRows(tickers, asOf, snapshotRows, recentBars, sharesByTicker),
    error: providerError,
  };
}
