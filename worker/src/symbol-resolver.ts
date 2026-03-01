import type { Env } from "./types";

export type ResolvedSymbol = {
  ticker: string;
  name: string;
  exchange: string | null;
  assetClass: string;
};

const TICKER_ALIASES: Record<string, string[]> = {
  VIX: ["^VIX"],
  VXN: ["^VXN"],
  VVIX: ["^VVIX"],
  XOI: ["^XOI"],
};

function candidateSymbols(tickerInput: string): string[] {
  const normalized = tickerInput.trim().toUpperCase();
  const aliases = TICKER_ALIASES[normalized] ?? [];
  return Array.from(new Set([normalized, ...aliases]));
}

async function resolveViaAlpaca(ticker: string, env: Env): Promise<ResolvedSymbol | null> {
  if (!env.ALPACA_API_KEY || !env.ALPACA_API_SECRET) return null;
  const res = await fetch(`https://paper-api.alpaca.markets/v2/assets/${encodeURIComponent(ticker)}`, {
    headers: {
      "APCA-API-KEY-ID": env.ALPACA_API_KEY,
      "APCA-API-SECRET-KEY": env.ALPACA_API_SECRET,
      "User-Agent": "market-command-centre/1.0",
    },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    symbol?: string;
    name?: string;
    exchange?: string;
    class?: string;
  };
  if (!json.symbol || !json.name) return null;
  return {
    ticker: json.symbol.toUpperCase(),
    name: json.name,
    exchange: json.exchange ?? null,
    assetClass: json.class?.toLowerCase() ?? "equity",
  };
}

async function resolveViaYahooOne(symbol: string): Promise<ResolvedSymbol | null> {
  const res = await fetch(
    `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`,
    { headers: { "User-Agent": "market-command-centre/1.0" } },
  );
  if (!res.ok) return null;
  const json = (await res.json()) as {
    quoteResponse?: {
      result?: Array<{
        symbol?: string;
        longName?: string;
        shortName?: string;
        fullExchangeName?: string;
        quoteType?: string;
      }>;
    };
  };
  const hit = json.quoteResponse?.result?.[0];
  if (!hit?.symbol) return null;
  const name = hit.longName ?? hit.shortName;
  if (!name) return null;
  const quoteType = (hit.quoteType ?? "").toLowerCase();
  return {
    ticker: hit.symbol.toUpperCase(),
    name,
    exchange: hit.fullExchangeName ?? null,
    assetClass: quoteType === "etf" ? "etf" : quoteType === "index" ? "index" : "equity",
  };
}

async function resolveViaYahoo(tickerInput: string): Promise<ResolvedSymbol | null> {
  for (const symbol of candidateSymbols(tickerInput)) {
    const hit = await resolveViaYahooOne(symbol);
    if (hit) return hit;
  }
  return null;
}

export async function resolveTickerMeta(tickerInput: string, env: Env): Promise<ResolvedSymbol | null> {
  const ticker = tickerInput.trim().toUpperCase();
  if (!/^[A-Z.\-^]{1,20}$/.test(ticker)) return null;

  // Prefer free-source metadata for display name consistency.
  const yahoo = await resolveViaYahoo(ticker);
  if (yahoo) {
    const exchangeHint = yahoo.exchange;
    const alpaca = await resolveViaAlpaca(ticker, env);
    return {
      ticker,
      name: yahoo.name,
      exchange: exchangeHint ?? alpaca?.exchange ?? null,
      assetClass: yahoo.assetClass ?? alpaca?.assetClass ?? "equity",
    };
  }

  const alpaca = await resolveViaAlpaca(ticker, env);
  if (alpaca) {
    return {
      ...alpaca,
      ticker,
    };
  }

  return null;
}
