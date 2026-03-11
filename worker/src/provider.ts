import type { Env } from "./types";

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

export interface MarketDataProvider {
  label: string;
  getDailyBars(tickers: string[], startDate: string, endDate: string): Promise<DailyBar[]>;
  getQuoteSnapshot?(tickers: string[]): Promise<Record<string, { price: number; prevClose: number }>>;
  getPremarketSnapshot?(tickers: string[]): Promise<Record<string, PremarketSnapshot>>;
}

type AlpacaPremarketSnapshotInput = {
  latestTrade?: { p?: number };
  minuteBar?: { c?: number; v?: number };
  dailyBar?: { c?: number; v?: number };
  prevDailyBar?: { c?: number };
};

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

  private async fetchCboeVixBars(ticker: string): Promise<DailyBar[]> {
    const upper = ticker.trim().toUpperCase();
    if (upper !== "VIX" && upper !== "^VIX") return [];
    const url = "https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv";
    const res = await fetch(url, {
      headers: {
        "User-Agent": "market-command-centre/1.0",
      },
    });
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
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2y`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "market-command-centre/1.0",
      },
    });
    if (!res.ok) return [];
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
          };
        }>;
      };
    };
    const result = json.chart?.result?.[0];
    const ts = result?.timestamp ?? [];
    const quote = result?.indicators?.quote?.[0];
    if (!quote || ts.length === 0) return [];
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
      if (![open, high, low, close].every((n) => typeof n === "number" && Number.isFinite(n as number))) continue;
      out.push({
        ticker: ticker.toUpperCase(),
        date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
        o: open as number,
        h: high as number,
        l: low as number,
        c: close as number,
        volume: typeof volumes[i] === "number" && Number.isFinite(volumes[i] as number) ? (volumes[i] as number) : 0,
      });
    }
    return out;
  }

  private async fetchTickerBars(ticker: string): Promise<DailyBar[]> {
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
      const symbol = this.symbolForStooq(ticker);
      const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=d`;
      let csv = "";
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const res = await fetch(url, {
          headers: {
            "User-Agent": "market-command-centre/1.0",
          },
        });
        if (res.ok) {
          csv = await res.text();
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
      if (!csv) return await this.fetchYahooIndexBars(ticker);
      const lines = csv.split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length <= 1) return await this.fetchYahooIndexBars(ticker);
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
        return await this.fetchYahooIndexBars(ticker);
      }
      return out;
    } catch (error) {
      console.error("stooq ticker fetch failed", { ticker, error });
      try {
        return await this.fetchYahooIndexBars(ticker);
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
      const settled = await Promise.allSettled(chunk.map((ticker) => this.fetchTickerBars(ticker)));
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
  private readonly stooqFallback = new StooqProvider();

  constructor(env: Env) {
    this.key = env.ALPACA_API_KEY ?? "";
    this.secret = env.ALPACA_API_SECRET ?? "";
    this.feed = env.ALPACA_FEED ?? "iex";
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

  private async fetchChunkWithIsolation(tickers: string[], startDate: string, endDate: string): Promise<DailyBar[]> {
    if (tickers.length === 0) return [];
    try {
      return await this.fetchChunk(tickers, startDate, endDate);
    } catch (error) {
      if (tickers.length === 1) {
        console.error("alpaca ticker fetch failed", { ticker: tickers[0], error });
        return [];
      }
      const mid = Math.ceil(tickers.length / 2);
      const left = tickers.slice(0, mid);
      const right = tickers.slice(mid);
      const [leftRows, rightRows] = await Promise.all([
        this.fetchChunkWithIsolation(left, startDate, endDate),
        this.fetchChunkWithIsolation(right, startDate, endDate),
      ]);
      return [...leftRows, ...rightRows];
    }
  }

  private async fetchChunk(tickers: string[], startDate: string, endDate: string): Promise<DailyBar[]> {
    const out: DailyBar[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        timeframe: "1Day",
        symbols: tickers.join(","),
        start: `${startDate}T00:00:00Z`,
        end: `${endDate}T23:59:59Z`,
        adjustment: "raw",
        sort: "asc",
        limit: "10000",
        feed: this.feed,
      });
      if (pageToken) params.set("page_token", pageToken);
      const res = await fetch(`${this.baseUrl}?${params.toString()}`, {
        headers: {
          "APCA-API-KEY-ID": this.key,
          "APCA-API-SECRET-KEY": this.secret,
          "User-Agent": "market-command-centre/1.0",
        },
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

      const present = new Set(rows.map((r) => r.ticker.toUpperCase()));
      const missing = batch.filter((ticker) => !present.has(ticker.toUpperCase()));
      if (missing.length > 0) {
        try {
          const fallbackRows = await this.stooqFallback.getDailyBars(missing, startDate, endDate);
          all.push(...fallbackRows.map((row) => ({ ...row, ticker: row.ticker.toUpperCase() })));
        } catch (error) {
          console.error("stooq fallback failed for alpaca missing tickers", { missingCount: missing.length, error });
        }
      }
    }
    return all;
  }

  async getQuoteSnapshot(tickers: string[]): Promise<Record<string, { price: number; prevClose: number }>> {
    const unique = Array.from(new Set(tickers.map((t) => t.toUpperCase())));
    const out: Record<string, { price: number; prevClose: number }> = {};
    const chunks = this.chunk(unique, 80);
    for (const chunk of chunks) {
      const params = new URLSearchParams({
        symbols: chunk.join(","),
        feed: this.feed,
      });
      const res = await fetch(`https://data.alpaca.markets/v2/stocks/snapshots?${params.toString()}`, {
        headers: {
          "APCA-API-KEY-ID": this.key,
          "APCA-API-SECRET-KEY": this.secret,
          "User-Agent": "market-command-centre/1.0",
        },
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Alpaca snapshot fetch failed (${res.status}): ${body.slice(0, 180)}`);
      }
      const json = (await res.json()) as {
        snapshots?: Record<string, { latestTrade?: { p?: number }; dailyBar?: { c?: number }; prevDailyBar?: { c?: number } }>;
      };
      for (const [ticker, snap] of Object.entries(json.snapshots ?? {})) {
        const price = snap.latestTrade?.p ?? snap.dailyBar?.c;
        const prevClose = snap.prevDailyBar?.c;
        if (typeof price !== "number" || typeof prevClose !== "number" || prevClose === 0) continue;
        out[ticker.toUpperCase()] = { price, prevClose };
      }
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
      const res = await fetch(`https://data.alpaca.markets/v2/stocks/snapshots?${params.toString()}`, {
        headers: {
          "APCA-API-KEY-ID": this.key,
          "APCA-API-SECRET-KEY": this.secret,
          "User-Agent": "market-command-centre/1.0",
        },
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Alpaca premarket snapshot fetch failed (${res.status}): ${body.slice(0, 180)}`);
      }
      const json = (await res.json()) as {
        snapshots?: Record<string, {
          latestTrade?: { p?: number };
          minuteBar?: { c?: number; v?: number };
          dailyBar?: { c?: number; v?: number };
          prevDailyBar?: { c?: number };
        }>;
      };
      for (const [ticker, snap] of Object.entries(json.snapshots ?? {})) {
        const parsed = extractPremarketSnapshotFromAlpacaSnapshot(snap);
        if (!parsed) continue;
        out[ticker.toUpperCase()] = parsed;
      }
    }
    return out;
  }
}

export function getProvider(env: Env): MarketDataProvider {
  const mode = (env.DATA_PROVIDER ?? "alpaca").toLowerCase();
  if (mode === "alpaca") {
    if (!env.ALPACA_API_KEY || !env.ALPACA_API_SECRET) {
      return new StooqProvider();
    }
    return new AlpacaProvider(env);
  }
  if (mode === "stooq") return new StooqProvider();
  if (mode === "synthetic" || mode === "csv") return new SyntheticProvider();
  if (!env.ALPACA_API_KEY || !env.ALPACA_API_SECRET) {
    return new StooqProvider();
  }
  return new AlpacaProvider(env);
}
