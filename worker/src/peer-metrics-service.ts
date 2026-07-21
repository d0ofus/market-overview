import { hasSharesOutstandingColumn } from "./peer-groups-service";
import { meteredFetchWithRetry } from "./provider-usage";
import type { Env } from "./types";

const TV_SCAN_URL = "https://scanner.tradingview.com/america/scan";
const TV_PROVIDER_LABEL = "TradingView Screener (america/stocks)";
const REQUEST_CHUNK_SIZE = 100;
const SHARE_QUERY_CHUNK_SIZE = 50;
const COMMON_TV_PREFIXES = ["NASDAQ", "NYSE", "AMEX"] as const;

export type PeerMetricRow = {
  ticker: string;
  price: number | null;
  change1d: number | null;
  change1w: number | null;
  marketCap: number | null;
  avgVolume: number | null;
  asOf: string;
  source: string;
};

export type PeerMetricInput = {
  ticker: string;
  exchange: string | null;
};

type TradingViewResponseRow = {
  s?: string;
  d?: unknown[];
};

type QuoteFundamentals = {
  marketCap: number | null;
  avgVolume: number | null;
  source: "yahoo-quote" | "fmp-quote";
};

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function normalizeTicker(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim().toUpperCase();
  if (!text) return null;
  const candidate = text.includes(":") ? text.split(":").pop() ?? text : text;
  return /^[A-Z0-9.\-^]{1,20}$/.test(candidate) ? candidate : null;
}

function normalizeExchangePrefix(exchange: string | null | undefined): string | null {
  const normalized = String(exchange ?? "").trim().toUpperCase();
  if (!normalized) return null;
  if (normalized.includes("NASDAQ")) return "NASDAQ";
  if (
    normalized === "NYSE"
    || normalized.includes("NEW YORK STOCK EXCHANGE")
  ) return "NYSE";
  if (
    normalized === "AMEX"
    || normalized.includes("NYSE AMERICAN")
    || normalized.includes("NYSE MKT")
    || normalized.includes("ARCA")
  ) return "AMEX";
  return null;
}

function buildTradingViewTickers(input: PeerMetricInput): string[] {
  const ticker = normalizeTicker(input.ticker);
  if (!ticker) return [];
  const preferredPrefix = normalizeExchangePrefix(input.exchange);
  const orderedPrefixes = preferredPrefix
    ? [preferredPrefix, ...COMMON_TV_PREFIXES.filter((prefix) => prefix !== preferredPrefix)]
    : [...COMMON_TV_PREFIXES];
  return orderedPrefixes.map((prefix) => `${prefix}:${ticker}`);
}

function mapTradingViewRows(
  rows: TradingViewResponseRow[] | null | undefined,
  asOf: string,
): Map<string, PeerMetricRow> {
  const result = new Map<string, PeerMetricRow>();
  for (const row of rows ?? []) {
    const ticker = normalizeTicker(row.s);
    if (!ticker || result.has(ticker)) continue;
    const data = Array.isArray(row.d) ? row.d : [];
    result.set(ticker, {
      ticker,
      price: asFiniteNumber(data[0]),
      change1d: asFiniteNumber(data[1]),
      marketCap: asFiniteNumber(data[2]),
      avgVolume: asFiniteNumber(data[3]),
      change1w: asFiniteNumber(data[4]),
      asOf,
      source: TV_PROVIDER_LABEL,
    });
  }
  return result;
}

export function buildPeerMetricRows(
  tickers: string[],
  asOf: string,
  snapshotRows: Record<string, { price: number; prevClose: number }>,
  recentBars: Array<{ ticker: string; date: string; c: number; volume: number }>,
  sharesByTicker: Map<string, number | null>,
  quoteFundamentalsByTicker: Map<string, QuoteFundamentals> = new Map(),
): PeerMetricRow[] {
  const barsByTicker = new Map<string, number[]>();
  const closesByTicker = new Map<string, number[]>();
  for (const row of recentBars) {
    const ticker = String(row.ticker ?? "").trim().toUpperCase();
    const current = barsByTicker.get(ticker) ?? [];
    current.push(Number(row.volume ?? 0));
    barsByTicker.set(ticker, current);

    const closes = closesByTicker.get(ticker) ?? [];
    closes.push(Number(row.c ?? 0));
    closesByTicker.set(ticker, closes);
  }

  return tickers.map((tickerInput) => {
    const ticker = String(tickerInput ?? "").trim().toUpperCase();
    const latestSnapshot = snapshotRows[ticker];
    const quoteFundamentals = quoteFundamentalsByTicker.get(ticker);
    const closes = (closesByTicker.get(ticker) ?? []).filter((value) => Number.isFinite(value) && value > 0);
    const fallbackPrice = closes.at(-1);
    const fallbackPrevClose = closes.length >= 2 ? closes.at(-2) ?? null : null;
    const fallbackPrevWeekClose = closes.length >= 6 ? closes.at(-6) ?? null : null;
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
    const change1w = typeof price === "number" && typeof fallbackPrevWeekClose === "number" && fallbackPrevWeekClose > 0
      ? ((price - fallbackPrevWeekClose) / fallbackPrevWeekClose) * 100
      : null;
    const sharesOutstanding = sharesByTicker.get(ticker);
    const avgVolumeFromBars = mean(
      (barsByTicker.get(ticker) ?? [])
        .slice(-30)
        .filter((value) => Number.isFinite(value) && value > 0),
    );
    const marketCapFromShares = typeof price === "number" && typeof sharesOutstanding === "number"
      ? price * sharesOutstanding
      : null;
    const marketCap = quoteFundamentals?.marketCap ?? marketCapFromShares;
    const avgVolume = quoteFundamentals?.avgVolume ?? avgVolumeFromBars;
    const sourceParts = ["alpaca"];
    if (typeof quoteFundamentals?.marketCap === "number" || typeof quoteFundamentals?.avgVolume === "number") {
      sourceParts.push(quoteFundamentals.source);
    } else if (marketCapFromShares != null) {
      sourceParts.push("seeded-shares");
    }
    return {
      ticker,
      price,
      change1d,
      change1w,
      marketCap,
      avgVolume,
      asOf,
      source: sourceParts.join("+"),
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

async function fetchTradingViewPeerMetricMap(env: Env, inputs: PeerMetricInput[], asOf: string): Promise<Map<string, PeerMetricRow>> {
  const requestedSymbols = Array.from(new Set(inputs.flatMap(buildTradingViewTickers)));
  if (requestedSymbols.length === 0) return new Map();

  const chunks = chunk(requestedSymbols, REQUEST_CHUNK_SIZE);
  const maps = await Promise.all(chunks.map(async (symbolChunk) => {
    const payload = {
      markets: ["america"],
      symbols: {
        query: { types: [] },
        tickers: symbolChunk,
      },
      options: { lang: "en" },
      columns: ["close", "change", "market_cap_basic", "average_volume_30d_calc", "Perf.W"],
      sort: { sortBy: "change", sortOrder: "desc" as const },
      range: [0, symbolChunk.length],
    };
    const response = await meteredFetchWithRetry(env, TV_SCAN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "market-command-centre/1.0",
      },
      body: JSON.stringify(payload),
    }, {
      providerKey: "tradingview",
      endpointKey: "peer-metrics",
      caller: "peer-metrics",
      symbolCount: symbolChunk.length,
    }, 8_000);
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`TradingView peer metrics request failed (${response.status}): ${body.slice(0, 180)}`);
    }
    const body = await response.json() as { data?: TradingViewResponseRow[] };
    return mapTradingViewRows(body.data, asOf);
  }));

  const merged = new Map<string, PeerMetricRow>();
  for (const map of maps) {
    for (const [ticker, row] of map.entries()) {
      if (!merged.has(ticker)) merged.set(ticker, row);
    }
  }
  return merged;
}

export async function refreshPeerMetrics(
  env: Env,
  inputs: PeerMetricInput[],
): Promise<{ rows: PeerMetricRow[]; error: string | null }> {
  const dedupedInputs = Array.from(
    new Map(
      inputs
        .map((input) => {
          const ticker = normalizeTicker(input.ticker);
          if (!ticker) return null;
          return [ticker, { ticker, exchange: input.exchange ?? null }] as const;
        })
        .filter((entry): entry is readonly [string, PeerMetricInput] => Boolean(entry)),
    ).values(),
  );
  if (dedupedInputs.length === 0) return { rows: [], error: null };

  const asOf = new Date().toISOString();
  try {
    const rowsByTicker = await fetchTradingViewPeerMetricMap(env, dedupedInputs, asOf);
      const rows = dedupedInputs.map(({ ticker }) => rowsByTicker.get(ticker) ?? {
        ticker,
        price: null,
        change1d: null,
        change1w: null,
        marketCap: null,
        avgVolume: null,
        asOf,
      source: TV_PROVIDER_LABEL,
    });
    const missingTickers = rows.filter((row) => row.price == null && row.change1d == null && row.marketCap == null && row.avgVolume == null);
    const result = {
      rows,
      error: missingTickers.length > 0
        ? `TradingView did not return live metrics for ${missingTickers.length} ticker${missingTickers.length === 1 ? "" : "s"}.`
        : null,
    };
    await persistPeerMetrics(env, result.rows);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load TradingView peer metrics.";
    const result = {
      rows: dedupedInputs.map(({ ticker }) => ({
        ticker,
        price: null,
        change1d: null,
        change1w: null,
        marketCap: null,
        avgVolume: null,
        asOf,
        source: TV_PROVIDER_LABEL,
      })),
      error: message,
    };
    await persistPeerMetrics(env, result.rows);
    return result;
  }
}

async function persistPeerMetrics(env: Env, rows: PeerMetricRow[]): Promise<void> {
  if (rows.length === 0) return;
  const statements = rows.map((row) => env.DB.prepare(
    `INSERT INTO peer_metric_cache
       (ticker, price, change_1d, change_1w, market_cap, avg_volume, as_of, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(ticker) DO UPDATE SET
       price = excluded.price,
       change_1d = excluded.change_1d,
       change_1w = excluded.change_1w,
       market_cap = excluded.market_cap,
       avg_volume = excluded.avg_volume,
       as_of = excluded.as_of,
       source = excluded.source,
       updated_at = CURRENT_TIMESTAMP`,
  ).bind(
    row.ticker,
    row.price,
    row.change1d,
    row.change1w,
    row.marketCap,
    row.avgVolume,
    row.asOf,
    row.source,
  ));
  for (let offset = 0; offset < statements.length; offset += 100) {
    await env.DB.batch(statements.slice(offset, offset + 100));
  }
}

export async function loadPeerMetrics(
  env: Env,
  inputs: PeerMetricInput[],
): Promise<{ rows: PeerMetricRow[]; error: string | null }> {
  const tickers = Array.from(new Set(inputs.map((input) => normalizeTicker(input.ticker)).filter((ticker): ticker is string => Boolean(ticker))));
  if (tickers.length === 0) return { rows: [], error: null };
  const rowsByTicker = new Map<string, PeerMetricRow>();
  for (const tickerChunk of chunk(tickers, REQUEST_CHUNK_SIZE)) {
    const rows = await env.DB.prepare(
      `SELECT ticker, price, change_1d as change1d, change_1w as change1w,
              market_cap as marketCap, avg_volume as avgVolume, as_of as asOf, source
         FROM peer_metric_cache
        WHERE ticker IN (${tickerChunk.map(() => "?").join(",")})`,
    ).bind(...tickerChunk).all<PeerMetricRow>();
    for (const row of rows.results ?? []) rowsByTicker.set(row.ticker.toUpperCase(), row);
  }
  const asOf = new Date().toISOString();
  const rows = tickers.map((ticker) => rowsByTicker.get(ticker) ?? {
    ticker,
    price: null,
    change1d: null,
    change1w: null,
    marketCap: null,
    avgVolume: null,
    asOf,
    source: "stored-peer-metrics",
  });
  const missing = rows.filter((row) => !rowsByTicker.has(row.ticker));
  return {
    rows,
    error: missing.length > 0
      ? `${missing.length} ticker${missing.length === 1 ? " has" : "s have"} no stored metrics; a scheduled or manual refresh is required.`
      : null,
  };
}
