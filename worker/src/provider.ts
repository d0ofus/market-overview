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

export interface MarketDataProvider {
  label: string;
  getDailyBars(tickers: string[], startDate: string, endDate: string): Promise<DailyBar[]>;
  getQuoteSnapshot?(tickers: string[]): Promise<Record<string, { price: number; prevClose: number }>>;
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
  };

  private symbolForStooq(ticker: string): string {
    const t = ticker.trim().toLowerCase();
    const mapped = this.aliases[t.toUpperCase()];
    if (mapped) return mapped;
    if (t.startsWith("^")) return t;
    if (t.includes(".")) return t;
    return `${t}.us`;
  }

  private async fetchTickerBars(ticker: string): Promise<DailyBar[]> {
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
    if (!csv) return [];
    const lines = csv.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length <= 1) return [];
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
    return out;
  }

  async getDailyBars(tickers: string[], startDate: string, endDate: string): Promise<DailyBar[]> {
    const all: DailyBar[] = [];
    const batchSize = 4;
    for (let i = 0; i < tickers.length; i += batchSize) {
      const chunk = tickers.slice(i, i + batchSize);
      const rows = await Promise.all(chunk.map((ticker) => this.fetchTickerBars(ticker)));
      for (const tickerBars of rows) {
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
    const batches = this.chunk(unique, 100);
    const all: DailyBar[] = [];
    for (const batch of batches) {
      let rows: DailyBar[] = [];
      try {
        rows = await this.fetchChunk(batch, startDate, endDate);
      } catch (error) {
        // Keep moving and use fallback for this batch.
        console.error("alpaca batch fetch failed, trying fallback", { batch, error });
      }
      all.push(...rows);

      const present = new Set(rows.map((r) => r.ticker.toUpperCase()));
      const missing = batch.filter((ticker) => !present.has(ticker.toUpperCase()));
      if (missing.length > 0) {
        const fallbackRows = await this.stooqFallback.getDailyBars(missing, startDate, endDate);
        all.push(...fallbackRows.map((row) => ({ ...row, ticker: row.ticker.toUpperCase() })));
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
}

export function getProvider(env: Env): MarketDataProvider {
  const mode = (env.DATA_PROVIDER ?? "alpaca").toLowerCase();
  if (mode === "alpaca") return new AlpacaProvider(env);
  if (mode === "stooq") return new StooqProvider();
  if (mode === "synthetic" || mode === "csv") return new SyntheticProvider();
  return new AlpacaProvider(env);
}
