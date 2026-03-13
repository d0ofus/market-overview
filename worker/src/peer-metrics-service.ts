import { getProvider } from "./provider";
import { hasSharesOutstandingColumn } from "./peer-groups-service";
import type { Env } from "./types";

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
    const change1d = typeof latestSnapshot?.price === "number" && typeof latestSnapshot?.prevClose === "number" && latestSnapshot.prevClose > 0
      ? ((latestSnapshot.price - latestSnapshot.prevClose) / latestSnapshot.prevClose) * 100
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
    const sharesOutstandingColumn = await hasSharesOutstandingColumn(env);
    const shareRows = await env.DB.prepare(
      `SELECT ticker${sharesOutstandingColumn ? ", shares_outstanding as sharesOutstanding" : ", NULL as sharesOutstanding"} FROM symbols WHERE ticker IN (${tickers.map(() => "?").join(",")})`,
    )
      .bind(...tickers)
      .all<{ ticker: string; sharesOutstanding: number | null }>();
    sharesByTicker = new Map((shareRows.results ?? []).map((row) => [row.ticker.toUpperCase(), row.sharesOutstanding]));
  } catch (error) {
    errorMessages.push(error instanceof Error ? error.message : "Failed to load seeded share counts.");
  }

  return {
    rows: buildPeerMetricRows(tickers, asOf, snapshotRows, recentBars, sharesByTicker),
    error: errorMessages.length > 0 ? errorMessages.join(" | ") : null,
  };
}
