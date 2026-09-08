import { meteredFetch,ProviderBudgetExceededError } from "./provider-usage";
import type { Env } from "./types";
import type { MarketHistoryBar } from "./market-history";

type AlpacaBar = { t: string; o: number; h: number; l: number; c: number; v: number };
export type EodPriceBar = MarketHistoryBar & { reportedVolume: number | null };

// Exact indices in the audited Overview, never ETF replacements. INSR identity:
// https://indexes.nasdaq.com/docs/methodology_INSR.pdf. Runtime metadata must
// still confirm INDEX/USD/name before any mapped Yahoo response is accepted.
const INDEX_SYMBOLS: Record<string, { symbol: string; name: RegExp }> = {
  VIX: { symbol: "^VIX", name: /volatility|\bVIX\b/i },
  XOI: { symbol: "^XOI", name: /oil/i },
  XAU: { symbol: "^XAU", name: /gold.*silver|silver.*gold/i },
  XNG: { symbol: "^XNG", name: /natural gas/i },
  OSX: { symbol: "^OSX", name: /oil.*service/i },
  BKX: { symbol: "^BKX", name: /bank/i },
  INSR: { symbol: "^INSR", name: /nasdaq.*insurance|insurance.*nasdaq/i },
};
const MARKET_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
});
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ALPACA_SYMBOLS = 100;
const MAX_ALPACA_PAGES = 100;
const sleep = (ms: number) => ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

export function yahooEodSymbol(ticker: string): string {
  const normalized = ticker.trim().toUpperCase();
  return INDEX_SYMBOLS[normalized]?.symbol ?? normalized.replace(/\./g, "-");
}

export function yahooWindowMatchesAlpaca(ticker:string,bars:EodPriceBar[],overlap:EodPriceBar[]):boolean {
  if (INDEX_SYMBOLS[ticker]) return true; // identity was verified before this archive was written
  const primary=new Map(overlap.filter((row) => row.ticker===ticker && row.sourceProvider==="alpaca"
    && row.feed==="sip" && row.adjustment==="split").map((row) => [row.date,row.c]));
  const comparisons=bars.filter((bar) => bar.ticker===ticker && primary.has(bar.date)).map((bar) => Math.abs(bar.c/primary.get(bar.date)!-1));
  return comparisons.length>=2 && comparisons.every((difference) => Number.isFinite(difference) && difference<=0.005);
}

function validDate(value: string): boolean {
  const ms = Date.parse(`${value}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(ms)
    && new Date(ms).toISOString().slice(0, 10) === value;
}

export function validEodBar(bar: Pick<MarketHistoryBar, "o" | "h" | "l" | "c" | "date">, target: string): boolean {
  return validDate(bar.date) && bar.date <= target
    && [bar.o, bar.h, bar.l, bar.c].every((value) => Number.isFinite(value) && value > 0)
    && bar.h >= Math.max(bar.o, bar.c, bar.l) && bar.l <= Math.min(bar.o, bar.c, bar.h);
}

function range(start: string, target: string): { start: string; endMs: number } {
  if (!validDate(start) || !validDate(target) || start > target) throw new Error("eod-invalid-session-range");
  // UTC midnight precedes EST and EDT daily timestamps. A fixed -05:00 start
  // excluded the first summer bar (04:00 UTC). Filter exact NY dates below.
  return { start: `${start}T00:00:00.000Z`, endMs: Date.parse(`${target}T00:00:00Z`) + 30 * 60 * 60_000 };
}

function retryAfterMs(value: string | null): number | null {
  if (!value?.trim()) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

class EodProviderHttpError extends Error {
  constructor(readonly provider: "alpaca" | "yahoo", readonly status: number, readonly invalidSymbol = false) {
    super(`${provider}-http-${status}`);
  }
}

async function readBody<T>(response: Response, provider: string, decode: () => Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([decode(), new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        void response.body?.cancel().catch(() => undefined);
        reject(new Error(`${provider}-body-timeout`));
      }, REQUEST_TIMEOUT_MS);
    })]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export class EodPriceProvider {
  private lastAlpacaAt = 0;
  private lastYahooAt = 0;
  /** Supported symbols still return bars when a sibling is unsupported. */
  readonly symbolErrors = new Map<string, string>();

  constructor(private readonly env: Env) {}

  private async request(url: string, provider: "alpaca" | "yahoo"): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const last = provider === "alpaca" ? this.lastAlpacaAt : this.lastYahooAt;
      await sleep(Math.max(0, (provider === "alpaca" ? 610 : 2000) - (Date.now() - last)));
      if (provider === "alpaca") this.lastAlpacaAt = Date.now(); else this.lastYahooAt = Date.now();
      let response: Response;
      try {
        response = await meteredFetch(this.env, url, { headers: provider === "alpaca" ? {
          "APCA-API-KEY-ID": this.env.ALPACA_API_KEY ?? "",
          "APCA-API-SECRET-KEY": this.env.ALPACA_API_SECRET ?? "",
        } : { "User-Agent": "market-overview-eod/1.0" } },
        { providerKey: provider, endpointKey: "eod-history", caller: "github-eod" }, REQUEST_TIMEOUT_MS);
      } catch (error) {
        lastError = error;
        if (error instanceof ProviderBudgetExceededError && error.window==="minute" && attempt<2) {
          await sleep(60_000-Date.now()%60_000+25);
          continue;
        }
        if (/budget|circuit/i.test(String(error)) || attempt === 2) throw error;
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (response.ok) return response;
      let invalidSymbol = false;
      if (provider === "alpaca" && response.status === 400) {
        const body = await readBody(response, provider, () => response.text());
        invalidSymbol = /\b(?:invalid|unknown|unsupported|not found)\b.{0,80}\bsymbols?\b|\bsymbols?\b.{0,80}\b(?:invalid|unknown|unsupported|not found)\b/i.test(body);
      } else {
        await response.body?.cancel().catch(() => undefined);
      }
      lastError = new EodProviderHttpError(provider, response.status, invalidSymbol);
      // Authentication/entitlement failures are never relabeled as bad tickers.
      if (response.status !== 429 && response.status < 500) throw lastError;
      const delay = retryAfterMs(response.headers.get("Retry-After"));
      if (delay !== null && delay > 30_000) throw new Error(`${provider}-cooldown-${Math.ceil(delay / 1000)}s`);
      if (attempt === 2) break;
      await sleep(delay ?? 1000 * 2 ** attempt);
    }
    throw lastError;
  }

  private async alpacaPages(tickers: string[], start: string, target: string, adjustment: "split" | "raw"): Promise<EodPriceBar[]> {
    const bounds = range(start, target);
    const end = new Date(Math.min(Date.now() - 16 * 60_000, bounds.endMs)).toISOString();
    const out = new Map<string, EodPriceBar>();
    let token: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < MAX_ALPACA_PAGES; page += 1) {
      const params = new URLSearchParams({ symbols: tickers.join(","), timeframe: "1Day", start: bounds.start,
        end, feed: "sip", adjustment, asof: target, limit: "10000", sort: "asc" });
      if (token) params.set("page_token", token);
      const response = await this.request(`https://data.alpaca.markets/v2/stocks/bars?${params}`, "alpaca");
      const json = await readBody(response, "alpaca", () => response.json()) as {
        bars?: Record<string, AlpacaBar[]>; next_page_token?: string | null;
      };
      if (!json.bars || typeof json.bars !== "object" || Array.isArray(json.bars)
        || (json.next_page_token != null && (typeof json.next_page_token !== "string" || !json.next_page_token))) {
        throw new Error("alpaca-invalid-payload");
      }
      const fetchedAt = new Date().toISOString();
      for (const [ticker, rows] of Object.entries(json.bars)) {
        if (!tickers.includes(ticker)) throw new Error("alpaca-symbol-mismatch");
        if (!Array.isArray(rows)) throw new Error("alpaca-invalid-payload");
        for (const row of rows) {
          const timestamp = Date.parse(row.t);
          if (!Number.isFinite(timestamp)) throw new Error("alpaca-invalid-bar-timestamp");
          const date = MARKET_DATE.format(new Date(timestamp));
          const volume = typeof row.v === "number" && Number.isFinite(row.v) && row.v >= 0 ? row.v : null;
          const bar: EodPriceBar = { ticker, date, o: row.o, h: row.h, l: row.l, c: row.c, volume,
            reportedVolume: adjustment === "raw" ? volume : null, feed: "sip", sourceProvider: "alpaca",
            reportedVolumeCollectedAt:adjustment === "raw" && volume!==null ? fetchedAt : null,
            adjustment, observedAt: fetchedAt, fetchedAt };
          if (date < start || !validEodBar(bar, target)) continue;
          const key = `${ticker}:${date}`;
          const previous = out.get(key);
          if (previous && ["o", "h", "l", "c", "volume"].some((field) =>
            previous[field as keyof EodPriceBar] !== bar[field as keyof EodPriceBar])) throw new Error("alpaca-conflicting-duplicate-bar");
          out.set(key, bar);
        }
      }
      token = json.next_page_token ?? undefined;
      if (!token) return Array.from(out.values());
      if (seen.has(token)) throw new Error("alpaca-pagination-loop");
      seen.add(token);
    }
    throw new Error("alpaca-pagination-limit");
  }

  async alpaca(tickers: string[], start: string, target: string, adjustment: "split" | "raw" = "split"): Promise<EodPriceBar[]> {
    range(start, target);
    const unique = Array.from(new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean)));
    if (unique.length > MAX_ALPACA_SYMBOLS) throw new Error("alpaca-symbol-batch-limit");
    const supported = unique.filter((ticker) => {
      if (!INDEX_SYMBOLS[ticker]) return true;
      this.symbolErrors.set(ticker, "alpaca-index-unsupported");
      return false;
    });
    // At most 2N-1 sub-batches for N symbols. Only confirmed invalid-symbol 400s
    // split; invalid parameters, 401/403, 429 and 5xx propagate without splitting.
    let remaining = Math.max(1, supported.length * 2 - 1);
    const fetchBatch = async (symbols: string[]): Promise<EodPriceBar[]> => {
      if (!symbols.length) return [];
      if (remaining-- <= 0) throw new Error("alpaca-symbol-isolation-limit");
      try {
        return await this.alpacaPages(symbols, start, target, adjustment);
      } catch (error) {
        if (!(error instanceof EodProviderHttpError) || error.status !== 400 || !error.invalidSymbol) throw error;
        if (symbols.length === 1) {
          this.symbolErrors.set(symbols[0]!, "alpaca-symbol-unsupported");
          return [];
        }
        const split = Math.ceil(symbols.length / 2);
        return [...await fetchBatch(symbols.slice(0, split)), ...await fetchBatch(symbols.slice(split))];
      }
    };
    return fetchBatch(supported);
  }

  async yahoo(tickerInput: string, start: string, target: string, overlap: EodPriceBar[]): Promise<EodPriceBar[]> {
    const ticker = tickerInput.trim().toUpperCase();
    const bounds = range(start, target);
    const symbol = yahooEodSymbol(ticker);
    const params = new URLSearchParams({ interval: "1d", period1: String(Math.floor(Date.parse(bounds.start) / 1000)),
      period2: String(Math.floor(bounds.endMs / 1000)), events: "splits,div" });
    const response = await this.request(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`, "yahoo");
    type YahooResult = {
      meta?: { symbol?: string; exchangeTimezoneName?: string; instrumentType?: string; currency?: string; shortName?: string; longName?: string };
      timestamp?: number[];
      indicators?: { quote?: Array<{ open?: Array<number | null>; high?: Array<number | null>; low?: Array<number | null>; close?: Array<number | null>; volume?: Array<number | null> }> };
    };
    const json = await readBody(response, "yahoo", () => response.json()) as { chart?: { result?: YahooResult[]; error?: unknown } };
    const result = json.chart?.result?.[0];
    const index = INDEX_SYMBOLS[ticker];
    if (json.chart?.error || !result || result.meta?.symbol?.toUpperCase() !== symbol
      || result.meta?.exchangeTimezoneName !== "America/New_York"
      || (!index && (result.meta.currency!=="USD" || !["EQUITY","ETF"].includes(result.meta.instrumentType ?? "")))
      || (index && (result.meta.instrumentType !== "INDEX" || result.meta.currency !== "USD"
        || !index.name.test(`${result.meta.shortName ?? ""} ${result.meta.longName ?? ""}`)))) {
      throw new Error("yahoo-instrument-identity-unverified");
    }
    const quote = result.indicators?.quote?.[0];
    if (!quote || !Array.isArray(result.timestamp)) throw new Error("yahoo-empty-history");
    const fetchedAt = new Date().toISOString();
    const bars: EodPriceBar[] = [];
    for (let i = 0; i < result.timestamp.length; i += 1) {
      const timestamp = result.timestamp[i];
      if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) throw new Error("yahoo-invalid-bar-timestamp");
      const date = MARKET_DATE.format(new Date(timestamp * 1000));
      const values = [quote.open?.[i], quote.high?.[i], quote.low?.[i], quote.close?.[i]];
      if (!values.every((value): value is number => typeof value === "number" && Number.isFinite(value))) continue;
      const volume = quote.volume?.[i];
      const bar: EodPriceBar = { ticker, date, o: values[0]!, h: values[1]!, l: values[2]!, c: values[3]!,
        volume: typeof volume === "number" && Number.isFinite(volume) && volume >= 0 ? volume : null,
        reportedVolume: null, sourceProvider: "yahoo", feed: "yahoo-eod", adjustment: "split", fetchedAt, observedAt: fetchedAt };
      if (date >= start && validEodBar(bar, target)) bars.push(bar);
    }
    // Compare split-adjusted quote.close, never dividend-adjusted adjclose. Two
    // exact-date SIP overlaps are required for equity scale verification.
    const primaryByDate = new Map(overlap.filter((row) => row.ticker === ticker && row.sourceProvider === "alpaca"
      && row.feed === "sip" && row.adjustment === "split").map((row) => [row.date, row]));
    const comparisons = bars.flatMap((bar) => {
      const primary = primaryByDate.get(bar.date);
      return primary ? [Math.abs(bar.c / primary.c - 1)] : [];
    });
    if (!index && (comparisons.length < 2 || comparisons.some((difference) => !Number.isFinite(difference) || difference > 0.005))) {
      throw new Error("yahoo-price-basis-unverified");
    }
    return bars;
  }
}
