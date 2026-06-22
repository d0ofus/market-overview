import type { Env } from "./types";
import { EQUAL_WEIGHT_SECTOR_ETFS, ETF_CATALOG_TICKERS } from "./etf-catalog";
import { meteredFetch, type ProviderUsageMeta } from "./provider-usage";

export type DailyBar = {
  ticker: string;
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
  volume: number;
};

export type PremarketSnapshot = {
  price: number;
  prevClose: number;
  premarketPrice: number;
  premarketVolume: number;
};

export type QuoteSnapshot = {
  price: number;
  prevClose: number;
  change1d: number;
  source: "alpaca-snapshot";
  fetchedAt: string;
  tradeTimestamp?: string | null;
  dailyBarTimestamp?: string | null;
};

export interface MarketDataProvider {
  label: string;
  getDailyBars(tickers: string[], startDate: string, endDate: string): Promise<DailyBar[]>;
  getQuoteSnapshot?(tickers: string[]): Promise<Record<string, QuoteSnapshot>>;
  getPremarketSnapshot?(tickers: string[]): Promise<Record<string, PremarketSnapshot>>;
}

export type ProviderOptions = {
  yahooPreferredTickers?: Iterable<string>;
  fallbackEnabled?: boolean;
  fallbackScope?: "preferred" | "all";
  fallbackRequestLimit?: number;
};

const PROVIDER_FETCH_TIMEOUT_MS = 8_000;
const DEFAULT_FALLBACK_REQUESTS_PER_INVOCATION = 8;

function isAbortLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.message.toLowerCase().includes("aborted");
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = PROVIDER_FETCH_TIMEOUT_MS,
  env?: Env,
  meta?: ProviderUsageMeta,
): Promise<Response> {
  if (env && meta) {
    return await meteredFetch(env, input, init, meta, timeoutMs);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (isAbortLikeError(error)) {
      throw new Error(`Provider fetch timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function latestBarDate(bars: DailyBar[]): string | null {
  let latest: string | null = null;
  for (const bar of bars) {
    if (!latest || bar.date > latest) latest = bar.date;
  }
  return latest;
}

const IEX_FALLBACK_PREFERRED_TICKERS = new Set([
  ...ETF_CATALOG_TICKERS,
  ...EQUAL_WEIGHT_SECTOR_ETFS.map((row) => row.ticker),
  "SPY",
  "QQQ",
  "IWM",
  "DIA",
  "RSP",
  "QQQE",
  "EQAL",
  "EDOW",
  "VIXY",
  "GLD",
  "SLV",
  "USO",
  "TLT",
].map((ticker) => ticker.toUpperCase()));

function buildFallbackPreferredTickers(extraTickers?: Iterable<string>): Set<string> {
  const out = new Set(IEX_FALLBACK_PREFERRED_TICKERS);
  for (const ticker of extraTickers ?? []) {
    const normalized = ticker.trim().toUpperCase();
    if (normalized) out.add(normalized);
  }
  return out;
}

type FallbackRequestBudget = {
  limit: number;
  used: number;
};

function envInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.trunc(parsed));
}

function buildFallbackRequestBudget(env: Env, override?: number): FallbackRequestBudget {
  const limit = typeof override === "number"
    ? Math.max(0, Math.trunc(override))
    : envInt(env.MAX_FALLBACK_REQUESTS_PER_INVOCATION, DEFAULT_FALLBACK_REQUESTS_PER_INVOCATION);
  return { limit, used: 0 };
}

type AlpacaPremarketSnapshotInput = {
  latestTrade?: { p?: number };
  minuteBar?: { c?: number; v?: number };
  dailyBar?: { c?: number; v?: number };
  prevDailyBar?: { c?: number };
};

type AlpacaSnapshot = {
  latestTrade?: { p?: number; t?: string };
  minuteBar?: { c?: number; v?: number };
  dailyBar?: { c?: number; t?: string; v?: number };
  prevDailyBar?: { c?: number };
};

function extractAlpacaSnapshots(json: unknown): Record<string, AlpacaSnapshot> {
  if (!json || typeof json !== "object") return {};
  const raw = json as Record<string, unknown>;
  const nested = raw.snapshots;
  const source = nested && typeof nested === "object" ? nested as Record<string, unknown> : raw;
  const out: Record<string, AlpacaSnapshot> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!value || typeof value !== "object") continue;
    const upper = key.toUpperCase();
    if (!/^[A-Z0-9._-]+$/.test(upper)) continue;
    const snapshot = value as AlpacaSnapshot;
    if (snapshot.latestTrade || snapshot.minuteBar || snapshot.dailyBar || snapshot.prevDailyBar) {
      out[upper] = snapshot;
    }
  }
  return out;
}

export function extractPremarketSnapshotFromAlpacaSnapshot(
  snap: AlpacaPremarketSnapshotInput,
): PremarketSnapshot | null {
  const prevClose = snap.prevDailyBar?.c;
  const premarketPrice = snap.minuteBar?.c ?? snap.latestTrade?.p;
  const price = snap.minuteBar?.c ?? snap.latestTrade?.p ?? snap.dailyBar?.c;
  const premarketVolume = snap.minuteBar?.v ?? 0;
  if (
    typeof premarketPrice !== "number" ||
    typeof prevClose !== "number" ||
    typeof price !== "number" ||
    !Number.isFinite(premarketPrice) ||
    !Number.isFinite(prevClose) ||
    !Number.isFinite(price) ||
    prevClose <= 0
  ) {
    return null;
  }
  return {
    price,
    prevClose,
    premarketPrice,
    premarketVolume: typeof premarketVolume === "number" && Number.isFinite(premarketVolume) ? premarketVolume : 0,
  };
}

class SyntheticProvider implements MarketDataProvider {
  label = "Synthetic Seeded EOD";
  async getDailyBars(): Promise<DailyBar[]> {
    return [];
  }
}

class StooqProvider implements MarketDataProvider {
  label = "Stooq (Free Delayed EOD)";
  constructor(
    private readonly yahooPreferredTickers = new Set<string>(),
    private readonly fmpApiKey = "",
    private readonly alphaVantageApiKey = "",
    private readonly fallbackEnabled = true,
    private readonly env?: Env,
    private readonly fallbackBudget?: FallbackRequestBudget,
    private readonly caller = "market-data-fallback",
  ) {}

  private readonly aliases: Record<string, string> = {
    VIX: "^vix",
    VXN: "^vxn",
    VVIX: "^vvix",
    XOI: "^xoi",
  };
  private readonly yahooAliases: Record<string, string> = {
    VIX: "^VIX",
    VXN: "^VXN",
    VVIX: "^VVIX",
    XOI: "^XOI",
    NWX: "^NWX",
  };

  private symbolForStooq(ticker: string): string {
    const t = ticker.trim().toLowerCase();
    const mapped = this.aliases[t.toUpperCase()];
    if (mapped) return mapped;
    if (t.startsWith("^")) return t;
    if (t.includes(".")) return t;
    return `${t}.us`;
  }

  private yahooSymbolForTicker(ticker: string): string {
    const upper = ticker.trim().toUpperCase();
    if (this.yahooAliases[upper]) return this.yahooAliases[upper];
    if (upper.startsWith("^")) return upper;
    return upper;
  }

  private consumeFallbackRequest(providerKey: string, endpointKey: string, ticker: string): boolean {
    if (!this.fallbackBudget) return true;
    if (this.fallbackBudget.used >= this.fallbackBudget.limit) {
      console.warn("provider fallback request cap exhausted", {
        providerKey,
        endpointKey,
        ticker,
        used: this.fallbackBudget.used,
        limit: this.fallbackBudget.limit,
      });
      return false;
    }
    this.fallbackBudget.used += 1;
    return true;
  }

  private async fetchFallbackResponse(
    input: RequestInfo | URL,
    init: RequestInit,
    meta: Omit<ProviderUsageMeta, "caller" | "symbolCount"> & { ticker: string },
  ): Promise<Response | null> {
    if (!this.consumeFallbackRequest(meta.providerKey, meta.endpointKey, meta.ticker)) return null;
    return await fetchWithTimeout(input, init, PROVIDER_FETCH_TIMEOUT_MS, this.env, {
      providerKey: meta.providerKey,
      endpointKey: meta.endpointKey,
      caller: this.caller,
      symbolCount: 1,
    });
  }

  private async fetchCboeVixBars(ticker: string): Promise<DailyBar[]> {
    const upper = ticker.trim().toUpperCase();
    if (upper !== "VIX" && upper !== "^VIX") return [];
    const url = "https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv";
    const res = await this.fetchFallbackResponse(url, {
      headers: {
        "User-Agent": "market-command-centre/1.0",
      },
    }, { providerKey: "cboe", endpointKey: "vix-history", ticker: upper });
    if (!res) return [];
    if (!res.ok) return [];
    const csv = await res.text();
    const lines = csv.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length <= 1) return [];
    const out: DailyBar[] = [];
    for (const line of lines.slice(1)) {
      const cols = line.split(",");
      if (cols.length < 5) continue;
      const dateRaw = cols[0]?.trim() ?? "";
      const open = Number(cols[1]);
      const high = Number(cols[2]);
      const low = Number(cols[3]);
      const close = Number(cols[4]);
      if (!dateRaw || [open, high, low, close].some((n) => !Number.isFinite(n))) continue;
      const mmddyyyy = dateRaw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      const isoDate = mmddyyyy
        ? `${mmddyyyy[3]}-${mmddyyyy[1].padStart(2, "0")}-${mmddyyyy[2].padStart(2, "0")}`
        : dateRaw;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) continue;
      out.push({
        ticker: upper,
        date: isoDate,
        o: open,
        h: high,
        l: low,
        c: close,
        volume: 0,
      });
    }
    return out;
  }

  private async fetchYahooIndexBars(ticker: string): Promise<DailyBar[]> {
    const symbol = this.yahooSymbolForTicker(ticker);
    const hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
    for (const host of hosts) {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2y`;
      const res = await this.fetchFallbackResponse(url, {
        headers: {
          "User-Agent": "market-command-centre/1.0",
        },
      }, { providerKey: "yahoo", endpointKey: "chart", ticker });
      if (!res) continue;
      if (!res.ok) continue;
      const json = (await res.json()) as {
      chart?: {
        result?: Array<{
          timestamp?: number[];
          indicators?: {
            quote?: Array<{
              open?: Array<number | null>;
              high?: Array<number | null>;
              low?: Array<number | null>;
              close?: Array<number | null>;
              volume?: Array<number | null>;
            }>;
            adjclose?: Array<{
              adjclose?: Array<number | null>;
            }>;
          };
        }>;
      };
    };
      const result = json.chart?.result?.[0];
      const ts = result?.timestamp ?? [];
      const quote = result?.indicators?.quote?.[0];
      if (!quote || ts.length === 0) continue;
      const adjCloses = result?.indicators?.adjclose?.[0]?.adjclose ?? [];
      const opens = quote.open ?? [];
      const highs = quote.high ?? [];
      const lows = quote.low ?? [];
      const closes = quote.close ?? [];
      const volumes = quote.volume ?? [];
      const out: DailyBar[] = [];
      for (let i = 0; i < ts.length; i += 1) {
        const open = opens[i];
        const high = highs[i];
        const low = lows[i];
        const close = closes[i];
        const adjustedClose = adjCloses[i];
        if (![open, high, low, close].every((n) => typeof n === "number" && Number.isFinite(n as number))) continue;
        out.push({
          ticker: ticker.toUpperCase(),
          date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
          o: open as number,
          h: high as number,
          l: low as number,
          c: typeof adjustedClose === "number" && Number.isFinite(adjustedClose) ? adjustedClose : close as number,
          volume: typeof volumes[i] === "number" && Number.isFinite(volumes[i] as number) ? (volumes[i] as number) : 0,
        });
      }
      if (out.length > 0) return out;
    }
    return [];
  }

  private parseFmpBars(
    ticker: string,
    json:
      | Array<{ date?: string; open?: number; high?: number; low?: number; close?: number; adjClose?: number; volume?: number }>
      | { historical?: Array<{ date?: string; open?: number; high?: number; low?: number; close?: number; adjClose?: number; volume?: number }> },
  ): DailyBar[] {
    const rows = Array.isArray(json) ? json : json.historical ?? [];
    const out: DailyBar[] = [];
    for (const row of rows) {
      const date = row.date;
      const open = row.open;
      const high = row.high;
      const low = row.low;
      const close = row.adjClose ?? row.close;
      if (
        typeof date !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        ![open, high, low, close].every((n) => typeof n === "number" && Number.isFinite(n as number))
      ) {
        continue;
      }
      out.push({
        ticker: ticker.toUpperCase(),
        date,
        o: open as number,
        h: high as number,
        l: low as number,
        c: close as number,
        volume: typeof row.volume === "number" && Number.isFinite(row.volume) ? row.volume : 0,
      });
    }
    return out;
  }

  private parseFmpLightBars(
    ticker: string,
    json: Array<{ date?: string; price?: number; close?: number; volume?: number }>,
  ): DailyBar[] {
    const out: DailyBar[] = [];
    for (const row of json) {
      const date = row.date;
      const close = row.price ?? row.close;
      if (
        typeof date !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        typeof close !== "number" ||
        !Number.isFinite(close)
      ) {
        continue;
      }
      out.push({
        ticker: ticker.toUpperCase(),
        date,
        o: close,
        h: close,
        l: close,
        c: close,
        volume: typeof row.volume === "number" && Number.isFinite(row.volume) ? row.volume : 0,
      });
    }
    return out;
  }

  private async fetchFmpBars(ticker: string, startDate?: string, endDate?: string): Promise<DailyBar[]> {
    if (!this.fmpApiKey) return [];
    const params = new URLSearchParams({
      symbol: ticker.trim().toUpperCase(),
      apikey: this.fmpApiKey,
    });
    if (startDate) params.set("from", startDate);
    if (endDate) params.set("to", endDate);
    const headers = {
      Accept: "application/json",
      "User-Agent": "market-command-centre/1.0",
    };
    const stable = await this.fetchFallbackResponse(
      `https://financialmodelingprep.com/stable/historical-price-eod/full?${params.toString()}`,
      { headers },
      { providerKey: "fmp", endpointKey: "historical-price-eod-full", ticker },
    );
    if (stable?.ok) {
      const rows = this.parseFmpBars(ticker, await stable.json() as never);
      if (rows.length > 0) return rows;
    }

    const light = await this.fetchFallbackResponse(
      `https://financialmodelingprep.com/stable/historical-price-eod/light?${params.toString()}`,
      { headers },
      { providerKey: "fmp", endpointKey: "historical-price-eod-light", ticker },
    );
    if (light?.ok) {
      const rows = this.parseFmpLightBars(ticker, await light.json() as never);
      if (rows.length > 0) return rows;
    }

    const legacyParams = new URLSearchParams({
      apikey: this.fmpApiKey,
    });
    if (startDate) legacyParams.set("from", startDate);
    if (endDate) legacyParams.set("to", endDate);
    const symbol = encodeURIComponent(ticker.trim().toUpperCase());
    const legacy = await this.fetchFallbackResponse(
      `https://financialmodelingprep.com/api/v3/historical-price-full/${symbol}?${legacyParams.toString()}`,
      { headers },
      { providerKey: "fmp", endpointKey: "historical-price-full", ticker },
    );
    if (!legacy?.ok) return [];
    return this.parseFmpBars(ticker, await legacy.json() as never);
  }

  private async fetchAlphaVantageBars(ticker: string, startDate?: string, endDate?: string): Promise<DailyBar[]> {
    if (!this.alphaVantageApiKey) return [];
    const params = new URLSearchParams({
      function: "TIME_SERIES_DAILY_ADJUSTED",
      symbol: ticker.trim().toUpperCase(),
      outputsize: "compact",
      apikey: this.alphaVantageApiKey,
    });
    const res = await this.fetchFallbackResponse(`https://www.alphavantage.co/query?${params.toString()}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "market-command-centre/1.0",
      },
    }, { providerKey: "alpha-vantage", endpointKey: "daily-adjusted", ticker });
    if (!res) return [];
    if (!res.ok) return [];
    const json = (await res.json()) as {
      "Time Series (Daily)"?: Record<string, Record<string, string>>;
    };
    const series = json["Time Series (Daily)"] ?? {};
    const out: DailyBar[] = [];
    for (const [date, row] of Object.entries(series)) {
      if ((startDate && date < startDate) || (endDate && date > endDate)) continue;
      const open = Number(row["1. open"]);
      const high = Number(row["2. high"]);
      const low = Number(row["3. low"]);
      const close = Number(row["5. adjusted close"] ?? row["4. close"]);
      const volume = Number(row["6. volume"] ?? "0");
      if ([open, high, low, close].some((n) => !Number.isFinite(n))) continue;
      out.push({
        ticker: ticker.toUpperCase(),
        date,
        o: open,
        h: high,
        l: low,
        c: close,
        volume: Number.isFinite(volume) ? volume : 0,
      });
    }
    return out;
  }

  private async fetchTickerBars(ticker: string, startDate?: string, endDate?: string): Promise<DailyBar[]> {
    try {
      const upper = ticker.trim().toUpperCase();
      if (upper === "VIX" || upper === "^VIX") {
        const yahooVix = await this.fetchYahooIndexBars(ticker);
        if (yahooVix.length > 0) return yahooVix;
        const cboeVix = await this.fetchCboeVixBars(ticker);
        if (cboeVix.length > 0) return cboeVix;
      } else {
        const cboeVix = await this.fetchCboeVixBars(ticker);
        if (cboeVix.length > 0) return cboeVix;
      }
      if (this.fallbackEnabled && this.yahooPreferredTickers.has(upper)) {
        const yahooRows = await this.fetchYahooIndexBars(ticker);
        const yahooLatest = latestBarDate(yahooRows);
        if (yahooLatest && (!endDate || yahooLatest >= endDate)) return yahooRows;
        const fmpRows = await this.fetchFmpBars(ticker, startDate, endDate);
        const fmpLatest = latestBarDate(fmpRows);
        if (fmpLatest && (!endDate || fmpLatest >= endDate)) return fmpRows;
        const alphaVantageRows = await this.fetchAlphaVantageBars(ticker, startDate, endDate);
        const alphaVantageLatest = latestBarDate(alphaVantageRows);
        if (alphaVantageLatest && (!endDate || alphaVantageLatest >= endDate)) return alphaVantageRows;
        return [];
      }
      const symbol = this.symbolForStooq(ticker);
      const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=d`;
      let csv = "";
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const res = await this.fetchFallbackResponse(url, {
          headers: {
            "User-Agent": "market-command-centre/1.0",
          },
        }, { providerKey: "stooq", endpointKey: "daily-csv", ticker });
        if (!res) break;
        if (res.ok) {
          csv = await res.text();
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
      if (!csv) return this.fallbackEnabled ? await this.fetchYahooIndexBars(ticker) : [];
      const lines = csv.split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length <= 1) return this.fallbackEnabled ? await this.fetchYahooIndexBars(ticker) : [];
      const out: DailyBar[] = [];
      for (const line of lines.slice(1)) {
        const [date, o, h, l, c, v] = line.split(",");
        if (!date || c === "N/D") continue;
        const open = Number(o);
        const high = Number(h);
        const low = Number(l);
        const close = Number(c);
        const volume = Number(v || "0");
        if ([open, high, low, close].some((n) => Number.isNaN(n))) continue;
        out.push({
          ticker: ticker.toUpperCase(),
          date,
          o: open,
          h: high,
          l: low,
          c: close,
          volume: Number.isNaN(volume) ? 0 : volume,
        });
      }
      if (out.length === 0) {
        if (!this.fallbackEnabled) return [];
        return await this.fetchYahooIndexBars(ticker);
      }
      const stooqLatest = latestBarDate(out);
      if (this.fallbackEnabled && endDate && stooqLatest && stooqLatest < endDate) {
        const yahooRows = await this.fetchYahooIndexBars(ticker);
        const yahooLatest = latestBarDate(yahooRows);
        if (yahooLatest && yahooLatest > stooqLatest) return yahooRows;
        const fmpRows = await this.fetchFmpBars(ticker, startDate, endDate);
        const fmpLatest = latestBarDate(fmpRows);
        if (fmpLatest && fmpLatest > stooqLatest) return fmpRows;
        const alphaVantageRows = await this.fetchAlphaVantageBars(ticker, startDate, endDate);
        const alphaVantageLatest = latestBarDate(alphaVantageRows);
        if (alphaVantageLatest && alphaVantageLatest > stooqLatest) return alphaVantageRows;
      }
      return out;
    } catch (error) {
      console.error("stooq ticker fetch failed", { ticker, error });
      if (!this.fallbackEnabled) return [];
      try {
        const yahooRows = await this.fetchYahooIndexBars(ticker);
        if (yahooRows.length > 0) return yahooRows;
        const fmpRows = await this.fetchFmpBars(ticker, startDate, endDate);
        if (fmpRows.length > 0) return fmpRows;
        return await this.fetchAlphaVantageBars(ticker, startDate, endDate);
      } catch {
        return [];
      }
    }
  }

  async getDailyBars(tickers: string[], startDate: string, endDate: string): Promise<DailyBar[]> {
    const all: DailyBar[] = [];
    const batchSize = 4;
    for (let i = 0; i < tickers.length; i += batchSize) {
      const chunk = tickers.slice(i, i + batchSize);
      const settled = await Promise.allSettled(chunk.map((ticker) => this.fetchTickerBars(ticker, startDate, endDate)));
      for (const item of settled) {
        if (item.status !== "fulfilled") continue;
        const tickerBars = item.value;
        all.push(
          ...tickerBars.filter((b) => b.date >= startDate && b.date <= endDate),
        );
      }
    }
    return all;
  }
}

class AlpacaProvider implements MarketDataProvider {
  label = "Alpaca (IEX Delayed Daily Bars)";
  private readonly baseUrl = "https://data.alpaca.markets/v2/stocks/bars";
  private readonly key: string;
  private readonly secret: string;
  private readonly feed: string;
  private readonly fallbackEnabled: boolean;
  private readonly fallbackPreferredTickers: Set<string>;
  private readonly fallbackScope: "preferred" | "all";
  private readonly stooqFallback: StooqProvider;

  constructor(private readonly env: Env, options: ProviderOptions = {}) {
    this.key = env.ALPACA_API_KEY ?? "";
    this.secret = env.ALPACA_API_SECRET ?? "";
    this.feed = env.ALPACA_FEED ?? "iex";
    this.fallbackEnabled = options.fallbackEnabled ?? true;
    this.fallbackScope = options.fallbackScope ?? "preferred";
    this.fallbackPreferredTickers = buildFallbackPreferredTickers(options.yahooPreferredTickers);
    this.stooqFallback = new StooqProvider(
      this.fallbackPreferredTickers,
      env.FMP_API_KEY ?? "",
      env.ALPHA_VANTAGE_API_KEY ?? "",
      this.fallbackEnabled,
      env,
      buildFallbackRequestBudget(env, options.fallbackRequestLimit),
    );
    if (!this.key || !this.secret) {
      throw new Error("ALPACA_API_KEY and ALPACA_API_SECRET are required when DATA_PROVIDER=alpaca");
    }
  }

  private chunk<T>(arr: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  private normalizeDate(ts: string): string {
    return ts.slice(0, 10);
  }

  private async fetchChunkWithIsolation(tickers: string[], startDate: string, endDate: string, feed = this.feed): Promise<DailyBar[]> {
    if (tickers.length === 0) return [];
    try {
      return await this.fetchChunk(tickers, startDate, endDate, feed);
    } catch (error) {
      if (tickers.length === 1) {
        console.error("alpaca ticker fetch failed", { ticker: tickers[0], error });
        return [];
      }
      const mid = Math.ceil(tickers.length / 2);
      const left = tickers.slice(0, mid);
      const right = tickers.slice(mid);
      const [leftRows, rightRows] = await Promise.all([
        this.fetchChunkWithIsolation(left, startDate, endDate, feed),
        this.fetchChunkWithIsolation(right, startDate, endDate, feed),
      ]);
      return [...leftRows, ...rightRows];
    }
  }

  private async fetchChunk(tickers: string[], startDate: string, endDate: string, feed = this.feed): Promise<DailyBar[]> {
    const out: DailyBar[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        timeframe: "1Day",
        symbols: tickers.join(","),
        start: `${startDate}T00:00:00Z`,
        end: `${endDate}T23:59:59Z`,
        adjustment: "all",
        sort: "asc",
        limit: "10000",
        feed,
      });
      if (pageToken) params.set("page_token", pageToken);
      const res = await fetchWithTimeout(`${this.baseUrl}?${params.toString()}`, {
        headers: {
          "APCA-API-KEY-ID": this.key,
          "APCA-API-SECRET-KEY": this.secret,
          "User-Agent": "market-command-centre/1.0",
        },
      }, PROVIDER_FETCH_TIMEOUT_MS, this.env, {
        providerKey: "alpaca",
        endpointKey: `daily-bars-${feed}`,
        caller: "daily-bars",
        symbolCount: tickers.length,
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Alpaca bars fetch failed (${res.status}): ${body.slice(0, 180)}`);
      }
      const json = (await res.json()) as {
        bars?: Record<string, Array<{ t: string; o: number; h: number; l: number; c: number; v?: number }>>;
        next_page_token?: string | null;
      };
      for (const [ticker, bars] of Object.entries(json.bars ?? {})) {
        for (const b of bars) {
          out.push({
            ticker: ticker.toUpperCase(),
            date: this.normalizeDate(b.t),
            o: b.o,
            h: b.h,
            l: b.l,
            c: b.c,
            volume: b.v ?? 0,
          });
        }
      }
      pageToken = json.next_page_token ?? undefined;
    } while (pageToken);
    return out;
  }

  async getDailyBars(tickers: string[], startDate: string, endDate: string): Promise<DailyBar[]> {
    const unique = Array.from(new Set(tickers.map((t) => t.toUpperCase())));
    const batches = this.chunk(unique, 80);
    const all: DailyBar[] = [];
    for (const batch of batches) {
      const rows = await this.fetchChunkWithIsolation(batch, startDate, endDate);
      all.push(...rows);

      const latestByTicker = new Map<string, string>();
      for (const row of rows) {
        const ticker = row.ticker.toUpperCase();
        const latest = latestByTicker.get(ticker);
        if (!latest || row.date > latest) latestByTicker.set(ticker, row.date);
      }
      const isMissingOrStale = (ticker: string) => {
        const normalized = ticker.toUpperCase();
        const latest = latestByTicker.get(normalized);
        return !latest || latest < endDate;
      };
      if (this.fallbackEnabled && this.feed === "iex") {
        const preferredBatch = batch.filter((ticker) => (
          this.fallbackPreferredTickers.has(ticker.toUpperCase()) && isMissingOrStale(ticker)
        ));
        if (preferredBatch.length > 0) {
          try {
            const sipRows = await this.fetchChunk(preferredBatch, startDate, endDate, "sip");
            all.push(...sipRows);
            for (const row of sipRows) {
              const ticker = row.ticker.toUpperCase();
              const latest = latestByTicker.get(ticker);
              if (!latest || row.date > latest) latestByTicker.set(ticker, row.date);
            }
          } catch (error) {
            console.error("alpaca sip fallback failed for preferred tickers", { count: preferredBatch.length, error });
          }
        }
      }
      const missingOrStale = batch.filter((ticker) => (
        isMissingOrStale(ticker)
        && (this.fallbackScope === "all" || this.fallbackPreferredTickers.has(ticker.toUpperCase()))
      ));
      if (this.fallbackEnabled && missingOrStale.length > 0) {
        try {
          const fallbackRows = await this.stooqFallback.getDailyBars(missingOrStale, startDate, endDate);
          all.push(
            ...fallbackRows
              .map((row) => ({ ...row, ticker: row.ticker.toUpperCase() })),
          );
        } catch (error) {
          console.error("stooq fallback failed for alpaca missing/stale tickers", { missingCount: missingOrStale.length, error });
        }
      }
    }
    return all;
  }

  private async fetchQuoteSnapshotChunk(tickers: string[], feed = this.feed): Promise<Record<string, QuoteSnapshot>> {
    const params = new URLSearchParams({
      symbols: tickers.join(","),
      feed,
    });
    const fetchedAt = new Date().toISOString();
    const res = await fetchWithTimeout(`https://data.alpaca.markets/v2/stocks/snapshots?${params.toString()}`, {
      headers: {
        "APCA-API-KEY-ID": this.key,
        "APCA-API-SECRET-KEY": this.secret,
        "User-Agent": "market-command-centre/1.0",
      },
    }, PROVIDER_FETCH_TIMEOUT_MS, this.env, {
      providerKey: "alpaca",
      endpointKey: `quote-snapshots-${feed}`,
      caller: "quote-overlay",
      symbolCount: tickers.length,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Alpaca snapshot fetch failed (${res.status}): ${body.slice(0, 180)}`);
    }
    const json = await res.json();
    const out: Record<string, QuoteSnapshot> = {};
    for (const [ticker, snap] of Object.entries(extractAlpacaSnapshots(json))) {
      const price = snap.latestTrade?.p ?? snap.dailyBar?.c;
      const prevClose = snap.prevDailyBar?.c;
      if (typeof price !== "number" || typeof prevClose !== "number" || prevClose === 0) continue;
      out[ticker.toUpperCase()] = {
        price,
        prevClose,
        change1d: ((price - prevClose) / prevClose) * 100,
        source: "alpaca-snapshot",
        fetchedAt,
        tradeTimestamp: snap.latestTrade?.t ?? null,
        dailyBarTimestamp: snap.dailyBar?.t ?? null,
      };
    }
    return out;
  }

  private async fetchQuoteSnapshotChunkWithIsolation(
    tickers: string[],
    feed = this.feed,
    errors: string[] = [],
  ): Promise<Record<string, QuoteSnapshot>> {
    try {
      return await this.fetchQuoteSnapshotChunk(tickers, feed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "Alpaca snapshot fetch failed.");
      if (tickers.length <= 1) {
        errors.push(`${tickers[0]} ${feed}: ${message}`.slice(0, 240));
        console.error("alpaca snapshot ticker failed", { ticker: tickers[0], feed, error });
        return {};
      }
      console.error("alpaca snapshot chunk failed; isolating tickers", {
        count: tickers.length,
        feed,
        sampleTickers: tickers.slice(0, 8),
        error,
      });
      const mid = Math.ceil(tickers.length / 2);
      const [left, right] = await Promise.all([
        this.fetchQuoteSnapshotChunkWithIsolation(tickers.slice(0, mid), feed, errors),
        this.fetchQuoteSnapshotChunkWithIsolation(tickers.slice(mid), feed, errors),
      ]);
      return { ...left, ...right };
    }
  }

  async getQuoteSnapshot(tickers: string[]): Promise<Record<string, QuoteSnapshot>> {
    const unique = Array.from(new Set(tickers.map((t) => t.toUpperCase()).filter(Boolean)));
    const out: Record<string, QuoteSnapshot> = {};
    const chunks = this.chunk(unique, 80);
    const errors: string[] = [];
    for (const chunk of chunks) {
      const chunkSnapshots = await this.fetchQuoteSnapshotChunkWithIsolation(chunk, this.feed, errors);
      Object.assign(out, chunkSnapshots);

      if (this.fallbackEnabled && this.feed === "iex") {
        const missingPreferredTickers = chunk.filter((ticker) => (
          this.fallbackPreferredTickers.has(ticker.toUpperCase()) && !out[ticker.toUpperCase()]
        ));
        if (missingPreferredTickers.length > 0) {
          try {
            const sipSnapshots = await this.fetchQuoteSnapshotChunkWithIsolation(missingPreferredTickers, "sip", errors);
            Object.assign(out, sipSnapshots);
          } catch (error) {
            console.error("alpaca snapshot sip fallback failed for preferred tickers", {
              count: missingPreferredTickers.length,
              sampleTickers: missingPreferredTickers.slice(0, 8),
              error,
            });
          }
        }
      }
    }
    if (unique.length > 0 && Object.keys(out).length === 0 && errors.length > 0) {
      throw new Error(`Alpaca snapshot fetch failed for all requested tickers; sample errors: ${errors.slice(0, 5).join(" | ")}`);
    }
    return out;
  }

  async getPremarketSnapshot(tickers: string[]): Promise<Record<string, PremarketSnapshot>> {
    const unique = Array.from(new Set(tickers.map((t) => t.toUpperCase())));
    const out: Record<string, PremarketSnapshot> = {};
    const chunks = this.chunk(unique, 80);
    for (const chunk of chunks) {
      const params = new URLSearchParams({
        symbols: chunk.join(","),
        feed: this.feed,
      });
      const res = await fetchWithTimeout(`https://data.alpaca.markets/v2/stocks/snapshots?${params.toString()}`, {
        headers: {
          "APCA-API-KEY-ID": this.key,
          "APCA-API-SECRET-KEY": this.secret,
          "User-Agent": "market-command-centre/1.0",
        },
      }, PROVIDER_FETCH_TIMEOUT_MS, this.env, {
        providerKey: "alpaca",
        endpointKey: `premarket-snapshots-${this.feed}`,
        caller: "premarket",
        symbolCount: chunk.length,
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Alpaca premarket snapshot fetch failed (${res.status}): ${body.slice(0, 180)}`);
      }
      const json = await res.json();
      for (const [ticker, snap] of Object.entries(extractAlpacaSnapshots(json))) {
        const parsed = extractPremarketSnapshotFromAlpacaSnapshot(snap);
        if (!parsed) continue;
        out[ticker.toUpperCase()] = parsed;
      }
    }
    return out;
  }
}

export function getProvider(env: Env, options: ProviderOptions = {}): MarketDataProvider {
  const mode = (env.DATA_PROVIDER ?? "alpaca").toLowerCase();
  if (mode === "alpaca") {
    if (!env.ALPACA_API_KEY || !env.ALPACA_API_SECRET) {
      return new StooqProvider(new Set(), "", "", options.fallbackEnabled ?? true);
    }
    return new AlpacaProvider(env, options);
  }
  if (mode === "stooq") return new StooqProvider(new Set(), "", "", options.fallbackEnabled ?? true);
  if (mode === "synthetic" || mode === "csv") return new SyntheticProvider();
  if (!env.ALPACA_API_KEY || !env.ALPACA_API_SECRET) {
    return new StooqProvider(new Set(), "", "", options.fallbackEnabled ?? true);
  }
  return new AlpacaProvider(env, options);
}
