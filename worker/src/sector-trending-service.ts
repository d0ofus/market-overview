import { expectedEodSession } from "./eod-coordinator";
import { EodCatalogUnavailableError, loadEodCatalogRows } from "./eod-catalog-service";
import type { Env } from "./types";

type SectorSymbol = { ticker: string; name: string | null; sector: string };

/** Preserve the existing observed-bar five-day ranking and its >6-row window,
 * using the once-per-session catalog instead of hydrating every archive. */
export async function loadCatalogSectorTrending(env: Env, symbols: SectorSymbol[], days: number, now = new Date()) {
  const asOfDate = await expectedEodSession(env, now);
  if (!asOfDate) throw new EodCatalogUnavailableError("the completed exchange session cannot be verified");
  const byTicker = new Map(symbols.map((row) => [row.ticker.toUpperCase(), row]));
  const catalog = await loadEodCatalogRows(env, [...byTicker.keys()], asOfDate, { unavailableRows: "omit" });
  const startDate = new Date(now.getTime() - (days + 7) * 86_400_000).toISOString().slice(0, 10);
  const sectors = new Map<string, Array<{ ticker: string; name: string | null; trend5d: number; lastPrice: number; hasWindow: boolean }>>();
  for (const [ticker, row] of catalog) {
    if (!row.compatibility) throw new EodCatalogUnavailableError("sector ranking compatibility metadata must be rebuilt");
    if (!row.lastDate || row.lastDate < startDate || row.price === null) continue;
    const symbol = byTicker.get(ticker)!;
    const hasWindow = row.compatibility.trendWindowStartDate !== null && row.compatibility.trendWindowStartDate >= startDate
      && row.compatibility.trend5d !== null;
    const rows = sectors.get(symbol.sector) ?? [];
    rows.push({ ticker, name: symbol.name, trend5d: hasWindow ? row.compatibility.trend5d! : 0, lastPrice: row.price, hasWindow });
    sectors.set(symbol.sector, rows);
  }
  const rows = [...sectors.entries()].map(([sector, tickers]) => {
    tickers.sort((left, right) => right.trend5d - left.trend5d);
    const valid = tickers.filter((row) => row.hasWindow);
    return { sector, trend5d: valid.length ? valid.reduce((sum, row) => sum + row.trend5d, 0) / valid.length : 0,
      symbolCount: tickers.length, tickers };
  }).sort((left, right) => right.trend5d - left.trend5d);
  return { days, sectors: rows, asOfDate, unavailableTickerCount: [...byTicker.keys()].filter((ticker) => !catalog.has(ticker)).length };
}
