import type { Env } from "./types";
import * as XLSX from "xlsx";

export type EtfConstituent = {
  ticker: string;
  name: string | null;
  weight: number | null;
};

const SSGA_SELECT_SECTOR_SPDR_TICKERS = new Set([
  "XLY",
  "XLK",
  "XLC",
  "XLF",
  "XLU",
  "XLI",
  "XLRE",
  "XLV",
  "XLB",
  "XLE",
  "XLP",
]);

function normalizeTicker(value: string | null | undefined): string | null {
  if (!value) return null;
  const t = value.trim().toUpperCase();
  if (!/^[A-Z.\-]{1,20}$/.test(t)) return null;
  return t;
}

function parseWeightCell(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 && value <= 1 ? value * 100 : value;
  }
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[%,$\s]/g, "");
  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  return n > 0 && n <= 1 ? n * 100 : n;
}

function parseSsgaWorkbookRows(buffer: ArrayBuffer): EtfConstituent[] {
  const workbook = XLSX.read(buffer, { type: "array" });
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, blankrows: false });
    if (rows.length < 2) continue;
    const headerRowIndex = rows.findIndex((row) =>
      row.some((cell) => {
        if (typeof cell !== "string") return false;
        const v = cell.toLowerCase();
        return v.includes("ticker") || v.includes("symbol");
      }),
    );
    if (headerRowIndex < 0) continue;
    const header = rows[headerRowIndex] ?? [];
    let tickerIdx = -1;
    let weightIdx = -1;
    let nameIdx = -1;
    header.forEach((cell, i) => {
      const v = String(cell ?? "").toLowerCase();
      if (tickerIdx < 0 && (v.includes("ticker") || v.includes("symbol"))) tickerIdx = i;
      if (weightIdx < 0 && (v.includes("weight") || v.includes("% net assets") || v.includes("portfolio weight"))) weightIdx = i;
      if (nameIdx < 0 && (v.includes("security") || v.includes("name") || v.includes("holding"))) nameIdx = i;
    });
    if (tickerIdx < 0 || weightIdx < 0) continue;

    const out: EtfConstituent[] = [];
    for (const row of rows.slice(headerRowIndex + 1)) {
      const ticker = normalizeTicker(String(row[tickerIdx] ?? ""));
      if (!ticker) continue;
      if (ticker === "CASH" || ticker === "USD") continue;
      const weight = parseWeightCell(row[weightIdx]);
      const nameCell = nameIdx >= 0 ? row[nameIdx] : null;
      const name = typeof nameCell === "string" && nameCell.trim().length > 0 ? nameCell.trim() : null;
      out.push({ ticker, name, weight });
    }
    const dedup = new Map<string, EtfConstituent>();
    for (const row of out) {
      if (!dedup.has(row.ticker)) dedup.set(row.ticker, row);
    }
    if (dedup.size > 0) {
      return [...dedup.values()].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
    }
  }
  return [];
}

async function fetchSsgaSectorSpdrXlsxConstituents(etfTicker: string): Promise<EtfConstituent[]> {
  if (!SSGA_SELECT_SECTOR_SPDR_TICKERS.has(etfTicker)) {
    throw new Error("SSGA Select Sector source not configured for this ETF");
  }
  const url = `https://www.ssga.com/library-content/products/fund-data/etfs/us/pdhist-us-en-${etfTicker.toLowerCase()}.xlsx`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "market-command-centre/1.0",
      Accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/octet-stream,*/*",
      Referer: "https://www.ssga.com/",
    },
  });
  if (!res.ok) {
    throw new Error(`SSGA xlsx fetch failed (${res.status})`);
  }
  const buf = await res.arrayBuffer();
  const rows = parseSsgaWorkbookRows(buf);
  if (rows.length === 0) {
    throw new Error("SSGA xlsx parse returned no holdings");
  }
  return rows;
}

async function fetchYahooConstituents(etfTicker: string): Promise<EtfConstituent[]> {
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(etfTicker)}?modules=topHoldings`;
  const res = await fetch(url, { headers: { "User-Agent": "market-command-centre/1.0" } });
  if (!res.ok) {
    throw new Error(`Yahoo topHoldings fetch failed (${res.status})`);
  }
  const json = (await res.json()) as {
    quoteSummary?: {
      result?: Array<{
        topHoldings?: {
          holdings?: Array<{
            symbol?: string;
            holdingName?: string;
            holdingPercent?: { raw?: number } | number;
          }>;
        };
      }>;
      error?: { description?: string };
    };
  };
  const err = json.quoteSummary?.error?.description;
  if (err) throw new Error(err);
  const holdings = json.quoteSummary?.result?.[0]?.topHoldings?.holdings ?? [];
  const out: EtfConstituent[] = [];
  for (const h of holdings) {
    const ticker = normalizeTicker(h.symbol);
    if (!ticker) continue;
    const pctValue = typeof h.holdingPercent === "number" ? h.holdingPercent : h.holdingPercent?.raw;
    out.push({
      ticker,
      name: h.holdingName ?? null,
      weight: typeof pctValue === "number" ? pctValue * 100 : null,
    });
  }
  return out;
}

async function fetchStockAnalysisConstituents(etfTicker: string): Promise<EtfConstituent[]> {
  const url = `https://stockanalysis.com/etf/${encodeURIComponent(etfTicker.toLowerCase())}/holdings/`;
  const res = await fetch(url, { headers: { "User-Agent": "market-command-centre/1.0" } });
  if (!res.ok) {
    throw new Error(`StockAnalysis holdings fetch failed (${res.status})`);
  }
  const html = await res.text();
  const rowRegex = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
  const symbolRegex = /\/stocks\/([A-Z.\-]{1,20})\//i;
  const weightRegex = /([0-9]+(?:\.[0-9]+)?)%/i;
  const nameRegex = /<a[^>]*\/stocks\/[A-Z.\-]{1,20}\/[^>]*>([^<]+)<\/a>/i;
  const rows = html.match(rowRegex) ?? [];
  const out: EtfConstituent[] = [];
  for (const row of rows) {
    const symbolMatch = row.match(symbolRegex);
    if (!symbolMatch) continue;
    const ticker = normalizeTicker(symbolMatch[1]);
    if (!ticker) continue;
    const nameMatch = row.match(nameRegex);
    const weightMatch = row.match(weightRegex);
    out.push({
      ticker,
      name: nameMatch?.[1]?.trim() ?? null,
      weight: weightMatch ? Number(weightMatch[1]) : null,
    });
  }
  const dedup = new Map<string, EtfConstituent>();
  for (const row of out) if (!dedup.has(row.ticker)) dedup.set(row.ticker, row);
  return [...dedup.values()];
}

async function fetchEtfDbConstituents(etfTicker: string): Promise<EtfConstituent[]> {
  const url = `https://etfdb.com/etf/${encodeURIComponent(etfTicker.toUpperCase())}/#holdings`;
  const res = await fetch(url, { headers: { "User-Agent": "market-command-centre/1.0" } });
  if (!res.ok) {
    throw new Error(`ETFdb holdings fetch failed (${res.status})`);
  }
  const html = await res.text();
  const rowRegex = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
  const symbolRegex = /\/stock\/([A-Z.\-]{1,20})\//i;
  const weightRegex = /([0-9]+(?:\.[0-9]+)?)%/i;
  const nameRegex = /<a[^>]*\/stock\/[A-Z.\-]{1,20}\/[^>]*>([^<]+)<\/a>/i;
  const rows = html.match(rowRegex) ?? [];
  const out: EtfConstituent[] = [];
  for (const row of rows) {
    const symbolMatch = row.match(symbolRegex);
    if (!symbolMatch) continue;
    const ticker = normalizeTicker(symbolMatch[1]);
    if (!ticker) continue;
    const nameMatch = row.match(nameRegex);
    const weightMatch = row.match(weightRegex);
    out.push({
      ticker,
      name: nameMatch?.[1]?.trim() ?? null,
      weight: weightMatch ? Number(weightMatch[1]) : null,
    });
  }
  const dedup = new Map<string, EtfConstituent>();
  for (const row of out) if (!dedup.has(row.ticker)) dedup.set(row.ticker, row);
  return [...dedup.values()];
}

export async function syncEtfConstituents(env: Env, etfTickerInput: string): Promise<{ count: number; source: string }> {
  const etfTicker = normalizeTicker(etfTickerInput);
  if (!etfTicker) throw new Error("Invalid ETF ticker");
  let source = "ssga:fund-data-xlsx";
  let holdings: EtfConstituent[] = [];
  const errors: string[] = [];
  if (SSGA_SELECT_SECTOR_SPDR_TICKERS.has(etfTicker)) {
    try {
      holdings = await fetchSsgaSectorSpdrXlsxConstituents(etfTicker);
      if (holdings.length === 0) throw new Error("SSGA returned no holdings");
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "SSGA sync failed");
    }
  }

  if (holdings.length === 0) {
    source = "yahoo:topHoldings";
    try {
      holdings = await fetchYahooConstituents(etfTicker);
      if (holdings.length === 0) throw new Error("Yahoo returned no holdings");
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Yahoo sync failed");
    }
  }

  if (holdings.length === 0) {
    source = "stockanalysis:holdings-page";
    try {
      holdings = await fetchStockAnalysisConstituents(etfTicker);
      if (holdings.length === 0) throw new Error("StockAnalysis returned no holdings");
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "StockAnalysis sync failed");
    }
  }

  if (holdings.length === 0) {
    source = "etfdb:holdings-page";
    try {
      holdings = await fetchEtfDbConstituents(etfTicker);
      if (holdings.length === 0) throw new Error("ETFdb returned no holdings");
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "ETFdb sync failed");
    }
  }

  if (holdings.length > 0 && source !== "ssga:fund-data-xlsx" && SSGA_SELECT_SECTOR_SPDR_TICKERS.has(etfTicker)) {
    // Keep fallback source label explicit for visibility when SSGA is unavailable.
    source = `${source} (ssga-fallback)`;
  }

  if (holdings.length === 0) {
    const message = `No constituents returned for ${etfTicker}. Source errors: ${errors.join(" | ")}`.slice(0, 700);
    await env.DB.prepare(
      "INSERT OR REPLACE INTO etf_constituent_sync_status (etf_ticker, last_synced_at, status, error, source, records_count, updated_at) VALUES (?, ?, 'error', ?, ?, COALESCE((SELECT records_count FROM etf_constituent_sync_status WHERE etf_ticker = ?), 0), CURRENT_TIMESTAMP)",
    )
      .bind(etfTicker, new Date().toISOString(), message, source, etfTicker)
      .run();
    throw new Error(message);
  }

  const statements = [
    env.DB.prepare("DELETE FROM etf_constituents WHERE etf_ticker = ?").bind(etfTicker),
    ...holdings.map((h) =>
      env.DB.prepare(
        "INSERT OR REPLACE INTO etf_constituents (id, etf_ticker, constituent_ticker, constituent_name, weight, as_of_date, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
      ).bind(
        crypto.randomUUID(),
        etfTicker,
        h.ticker,
        h.name ?? null,
        h.weight,
        new Date().toISOString().slice(0, 10),
        source,
      ),
    ),
    ...holdings.map((h) =>
      env.DB.prepare(
        "INSERT OR IGNORE INTO symbols (ticker, name, exchange, asset_class) VALUES (?, ?, ?, 'equity')",
      ).bind(h.ticker, h.name ?? h.ticker, null),
    ),
    env.DB.prepare(
      "INSERT OR REPLACE INTO etf_constituent_sync_status (etf_ticker, last_synced_at, status, error, source, records_count, updated_at) VALUES (?, ?, 'ok', NULL, ?, ?, CURRENT_TIMESTAMP)",
    ).bind(etfTicker, new Date().toISOString(), source, holdings.length),
  ];
  await env.DB.batch(statements);
  return { count: holdings.length, source };
}
