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

const SSGA_SPDR_PAGE_BY_TICKER: Record<string, string> = {
  XLY: "https://www.ssga.com/us/en/intermediary/etfs/state-street-consumer-discretionary-select-sector-spdr-etf-xly",
  XLK: "https://www.ssga.com/us/en/intermediary/etfs/state-street-technology-select-sector-spdr-etf-xlk",
  XLC: "https://www.ssga.com/us/en/intermediary/etfs/state-street-communication-services-select-sector-spdr-etf-xlc",
  XLF: "https://www.ssga.com/us/en/intermediary/etfs/state-street-financial-select-sector-spdr-etf-xlf",
  XLU: "https://www.ssga.com/us/en/intermediary/etfs/state-street-utilities-select-sector-spdr-etf-xlu",
  XLI: "https://www.ssga.com/us/en/intermediary/etfs/state-street-industrial-select-sector-spdr-etf-xli",
  XLRE: "https://www.ssga.com/us/en/intermediary/etfs/state-street-real-estate-select-sector-spdr-etf-xlre",
  XLV: "https://www.ssga.com/us/en/intermediary/etfs/state-street-health-care-select-sector-spdr-etf-xlv",
  XLB: "https://www.ssga.com/us/en/intermediary/etfs/state-street-materials-select-sector-spdr-etf-xlb",
  XLE: "https://www.ssga.com/us/en/intermediary/etfs/state-street-energy-select-sector-spdr-etf-xle",
  XLP: "https://www.ssga.com/us/en/intermediary/etfs/state-street-consumer-staples-select-sector-spdr-etf-xlp",
};

function shouldPreferSsgaFundData(etfTicker: string): boolean {
  if (SSGA_SELECT_SECTOR_SPDR_TICKERS.has(etfTicker)) return true;
  // Most SPDR funds use X* symbols and can often be resolved through SSGA fund-data files.
  return /^X[A-Z]{1,5}$/.test(etfTicker);
}

function isTooManySubrequestsError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return /too many subrequests/i.test(text);
}

async function persistSyncErrorAndThrow(
  env: Env,
  etfTicker: string,
  source: string,
  errors: string[],
): Promise<never> {
  const dedupErrors = Array.from(new Set(errors));
  const message = `No constituents returned for ${etfTicker}. Source errors: ${dedupErrors.join(" | ")}`.slice(0, 700);
  await env.DB.prepare(
    "INSERT OR REPLACE INTO etf_constituent_sync_status (etf_ticker, last_synced_at, status, error, source, records_count, updated_at) VALUES (?, ?, 'error', ?, ?, COALESCE((SELECT records_count FROM etf_constituent_sync_status WHERE etf_ticker = ?), 0), CURRENT_TIMESTAMP)",
  )
    .bind(etfTicker, new Date().toISOString(), message, source, etfTicker)
    .run();
  throw new Error(message);
}

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

function findSsgaHeaderIndexes(rows: unknown[][]): { headerRowIndex: number; tickerIdx: number; weightIdx: number; nameIdx: number } | null {
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    let tickerIdx = -1;
    let weightIdx = -1;
    let nameIdx = -1;
    row.forEach((cell, i) => {
      const v = String(cell ?? "").toLowerCase().trim();
      if (tickerIdx < 0 && (v === "ticker" || v === "symbol" || v.includes("ticker symbol"))) tickerIdx = i;
      if (weightIdx < 0 && (v === "weight" || v.includes("% net assets") || v.includes("portfolio weight"))) weightIdx = i;
      if (nameIdx < 0 && (v === "name" || v.includes("security") || v.includes("holding"))) nameIdx = i;
    });
    if (tickerIdx >= 0 && weightIdx >= 0) {
      return { headerRowIndex: rowIndex, tickerIdx, weightIdx, nameIdx };
    }
  }
  return null;
}

function parseSsgaRows(rows: unknown[][]): EtfConstituent[] {
  if (rows.length < 2) return [];
  const idx = findSsgaHeaderIndexes(rows);
  if (!idx) return [];

  const out: EtfConstituent[] = [];
  for (const row of rows.slice(idx.headerRowIndex + 1)) {
    const ticker = normalizeTicker(String(row[idx.tickerIdx] ?? ""));
    if (!ticker || ticker === "CASH" || ticker === "USD") continue;
    const weight = parseWeightCell(row[idx.weightIdx]);
    const nameCell = idx.nameIdx >= 0 ? row[idx.nameIdx] : null;
    const name = typeof nameCell === "string" && nameCell.trim().length > 0 ? nameCell.trim() : null;
    out.push({ ticker, name, weight });
  }
  const dedup = new Map<string, EtfConstituent>();
  for (const row of out) {
    if (!dedup.has(row.ticker)) dedup.set(row.ticker, row);
  }
  return [...dedup.values()].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
}

function splitDelimitedRow(line: string, delimiter: "," | "\t"): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "\"") {
      if (inQuotes && line[i + 1] === "\"") {
        current += "\"";
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === delimiter && !inQuotes) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((v) => v.trim());
}

function parseSsgaDelimitedRows(raw: string): EtfConstituent[] {
  const lines = raw
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];

  const delimiter: "," | "\t" = lines.some((l) => l.includes("\t")) ? "\t" : ",";
  const rows = lines.map((l) => splitDelimitedRow(l, delimiter));
  return parseSsgaRows(rows as unknown[][]);
}

function parseSsgaWorkbookRows(buffer: ArrayBuffer): EtfConstituent[] {
  const workbook = XLSX.read(buffer, { type: "array" });
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, blankrows: false });
    const parsed = parseSsgaRows(rows as unknown[][]);
    if (parsed.length > 0) return parsed;
  }
  return [];
}

async function fetchSsgaFundDataConstituents(etfTicker: string): Promise<EtfConstituent[]> {
  const tickerLower = etfTicker.toLowerCase();
  const directCandidates = [
    `https://www.ssga.com/library-content/products/fund-data/etfs/us/holdings-daily-us-en-${tickerLower}.csv`,
    `https://www.ssga.com/library-content/products/fund-data/etfs/us/fund-holdings-us-en-${tickerLower}.csv`,
    `https://www.ssga.com/library-content/products/fund-data/etfs/us/fund-data-us-en-${tickerLower}.csv`,
    `https://www.ssga.com/library-content/products/fund-data/etfs/us/pdhist-us-en-${tickerLower}.csv`,
    `https://www.ssga.com/library-content/products/fund-data/etfs/us/pdhist-us-en-${tickerLower}.xlsx`,
    `https://www.ssga.com/library-content/products/fund-data/etfs/us/holdings-daily-us-en-${tickerLower}.xlsx`,
    `https://www.ssga.com/library-content/products/fund-data/etfs/us/fund-holdings-us-en-${tickerLower}.xlsx`,
    `https://www.ssga.com/library-content/products/fund-data/etfs/us/fund-data-us-en-${tickerLower}.xlsx`,
  ];

  const pageUrl = SSGA_SPDR_PAGE_BY_TICKER[etfTicker] ?? null;
  const pageCandidates: string[] = [];
  if (pageUrl) {
    try {
      const pageRes = await fetch(pageUrl, {
        headers: {
          "User-Agent": "market-command-centre/1.0",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });
      if (pageRes.ok) {
        const html = await pageRes.text();
        const matches = html.match(/https?:\/\/[^"'\\s>]+\.(?:xlsx|csv)/gi) ?? [];
        for (const m of matches) pageCandidates.push(m);

        const relMatches = html.match(/\/library-content\/[^"'\\s>]+\.(?:xlsx|csv)/gi) ?? [];
        for (const m of relMatches) pageCandidates.push(`https://www.ssga.com${m}`);
      }
    } catch {
      // continue with direct candidates
    }
  }

  const tried = new Set<string>();
  const candidates = [...pageCandidates, ...directCandidates].filter((u) => {
    const key = u.toLowerCase();
    if (tried.has(key)) return false;
    tried.add(key);
    return true;
  });

  const errors: string[] = [];
  for (const url of candidates) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "market-command-centre/1.0",
          Accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/octet-stream,*/*",
          Referer: pageUrl || "https://www.ssga.com/",
        },
      });
      if (!res.ok) {
        errors.push(`${new URL(url).pathname} (${res.status})`);
        continue;
      }
      const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
      const looksLikeXlsx =
        url.toLowerCase().endsWith(".xlsx") ||
        contentType.includes("sheet") ||
        contentType.includes("zip") ||
        contentType.includes("octet-stream");
      let rows: EtfConstituent[] = [];
      if (looksLikeXlsx) {
        const body = await res.arrayBuffer();
        rows = parseSsgaWorkbookRows(body);
      } else {
        const bodyText = await res.text();
        rows = parseSsgaDelimitedRows(bodyText);
      }
      if (rows.length > 0) return rows;
      errors.push(`${new URL(url).pathname} (parsed 0 rows from fund-data file)`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "unknown");
    }
  }
  throw new Error(`SSGA fund-data parse returned no holdings (${errors.slice(0, 5).join(" | ")})`);
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
  let source = "unknown";
  let holdings: EtfConstituent[] = [];
  const errors: string[] = [];
  if (shouldPreferSsgaFundData(etfTicker)) {
    source = "ssga:fund-data";
    try {
      holdings = await fetchSsgaFundDataConstituents(etfTicker);
      if (holdings.length === 0) throw new Error("SSGA returned no holdings");
    } catch (error) {
      const message = error instanceof Error ? error.message : "SSGA sync failed";
      errors.push(message);
      if (isTooManySubrequestsError(error)) {
        await persistSyncErrorAndThrow(env, etfTicker, source, errors);
      }
    }
  }

  if (holdings.length === 0) {
    source = "yahoo:topHoldings";
    try {
      holdings = await fetchYahooConstituents(etfTicker);
      if (holdings.length === 0) throw new Error("Yahoo returned no holdings");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Yahoo sync failed";
      errors.push(message);
      if (isTooManySubrequestsError(error)) {
        await persistSyncErrorAndThrow(env, etfTicker, source, errors);
      }
    }
  }

  if (holdings.length === 0) {
    source = "stockanalysis:holdings-page";
    try {
      holdings = await fetchStockAnalysisConstituents(etfTicker);
      if (holdings.length === 0) throw new Error("StockAnalysis returned no holdings");
    } catch (error) {
      const message = error instanceof Error ? error.message : "StockAnalysis sync failed";
      errors.push(message);
      if (isTooManySubrequestsError(error)) {
        await persistSyncErrorAndThrow(env, etfTicker, source, errors);
      }
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

  if (holdings.length > 0 && source !== "ssga:fund-data" && shouldPreferSsgaFundData(etfTicker)) {
    source = `${source} (ssga-preferred-fallback)`;
  }

  if (holdings.length === 0) {
    const dedupErrors = Array.from(new Set(errors));
    const message = `No constituents returned for ${etfTicker}. Source errors: ${dedupErrors.join(" | ")}`.slice(0, 700);
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
