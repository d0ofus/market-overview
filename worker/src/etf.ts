import type { Env } from "./types";
import * as XLSX from "xlsx";
import { ETF_CATALOG_BY_TICKER } from "./etf-catalog";

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

const INVESCO_KNOWN_PAGE_BY_TICKER: Record<string, string> = {
  TAN: "https://www.invesco.com/us/en/financial-products/etfs/invesco-solar-etf.html",
  PBW: "https://www.invesco.com/us/en/financial-products/etfs/invesco-wilderhill-clean-energy-etf.html",
  PJP: "https://www.invesco.com/us/en/financial-products/etfs/invesco-dynamic-pharmaceuticals-etf.html",
  PPA: "https://www.invesco.com/us/en/financial-products/etfs/invesco-aerospace-defense-etf.html",
  PSI: "https://www.invesco.com/us/en/financial-products/etfs/invesco-semiconductors-etf.html",
  PEJ: "https://www.invesco.com/us/en/financial-products/etfs/invesco-dynamic-leisure-and-entertainment-etf.html",
  PNQI: "https://www.invesco.com/us/en/financial-products/etfs/invesco-nasdaq-internet-etf.html",
  PBJ: "https://www.invesco.com/us/en/financial-products/etfs/invesco-dynamic-food-and-beverage-etf.html",
  DBA: "https://www.invesco.com/us/en/financial-products/etfs/invesco-db-agriculture-fund.html",
  DBC: "https://www.invesco.com/us/en/financial-products/etfs/invesco-db-commodity-index-tracking-fund.html",
  PPH: "https://www.invesco.com/us/en/financial-products/etfs/invesco-pharmaceuticals-etf.html",
};

const INVESCO_ETF_DISCOVERY_URLS = [
  "https://www.invesco.com/us/en/financial-products/etfs.html?assetClass=Equity",
];

const INVESCO_KNOWN_CUSIP_BY_TICKER: Record<string, string> = {
  TAN: "46138G706",
};

function shouldPreferSsgaFundData(etfTicker: string): boolean {
  if (SSGA_SELECT_SECTOR_SPDR_TICKERS.has(etfTicker)) return true;
  // Most SPDR funds use X* symbols and can often be resolved through SSGA fund-data files.
  return /^X[A-Z]{1,5}$/.test(etfTicker);
}

async function officialUrlForTicker(env: Env, etfTicker: string): Promise<string | null> {
  try {
    const watchlistRow = await env.DB.prepare(
      "SELECT source_url as sourceUrl FROM etf_watchlists WHERE ticker = ? ORDER BY list_type ASC LIMIT 1",
    )
      .bind(etfTicker)
      .first<{ sourceUrl: string | null }>();
    if (watchlistRow?.sourceUrl?.trim()) return watchlistRow.sourceUrl.trim();
  } catch {
    // Older schema without source_url can fall back to static mappings.
  }
  return ETF_CATALOG_BY_TICKER[etfTicker]?.exactUrl ?? INVESCO_KNOWN_PAGE_BY_TICKER[etfTicker] ?? null;
}

async function getInvescoPreference(env: Env, etfTicker: string): Promise<{ prefer: boolean; strict: boolean }> {
  if (INVESCO_KNOWN_PAGE_BY_TICKER[etfTicker]) return { prefer: true, strict: true };
  const row = await env.DB.prepare(
    "SELECT COALESCE((SELECT fund_name FROM etf_watchlists WHERE ticker = ? ORDER BY list_type ASC LIMIT 1), (SELECT name FROM symbols WHERE ticker = ? LIMIT 1)) as fundName",
  )
    .bind(etfTicker, etfTicker)
    .first<{ fundName: string | null }>();
  const name = (row?.fundName ?? "").toLowerCase();
  const matched = name.includes("invesco") || name.includes("powershares");
  return { prefer: matched, strict: matched };
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
  const t = value.trim().toUpperCase().replace(/\//g, ".");
  if (!/^[A-Z0-9.\-]{1,20}$/.test(t)) return null;
  return t;
}

function normalizeGlobalXTickerCell(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value.replace(/["']/g, "").trim().toUpperCase();
  if (!cleaned) return null;
  const firstToken = cleaned.split(/\s+/).find(Boolean) ?? cleaned;
  return normalizeTicker(firstToken);
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

function normalizeCsvUrl(raw: string, pageUrl: string): string | null {
  const cleaned = raw.replace(/&amp;/g, "&").trim();
  if (!cleaned) return null;
  if (/^https?:\/\//i.test(cleaned)) return cleaned;
  if (cleaned.startsWith("//")) return `https:${cleaned}`;
  if (cleaned.startsWith("/")) return `https://www.invesco.com${cleaned}`;
  try {
    return new URL(cleaned, pageUrl).toString();
  } catch {
    return null;
  }
}

function findInvescoHeaderIndexes(rows: string[][]): { headerRowIndex: number; tickerIdx: number; weightIdx: number; nameIdx: number } | null {
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    let tickerIdx = -1;
    let weightIdx = -1;
    let nameIdx = -1;
    row.forEach((cell, i) => {
      const v = String(cell ?? "").toLowerCase().trim();
      if (tickerIdx < 0 && (v.includes("ticker") || v.includes("symbol"))) tickerIdx = i;
      if (weightIdx < 0 && (v.includes("weight") || v.includes("% net assets") || v.includes("percent of fund") || v.includes("% of net assets") || v.includes("allocation"))) weightIdx = i;
      if (nameIdx < 0 && (v === "name" || v.includes("holding") || v.includes("security"))) nameIdx = i;
    });
    if (tickerIdx >= 0 && weightIdx >= 0) return { headerRowIndex: rowIndex, tickerIdx, weightIdx, nameIdx };
  }
  return null;
}

function parseInvescoDelimitedRows(raw: string): EtfConstituent[] {
  const lines = raw
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];

  const delimiter: "," | "\t" = lines.some((l) => l.includes("\t")) ? "\t" : ",";
  const rows = lines.map((l) => splitDelimitedRow(l, delimiter));
  const header = findInvescoHeaderIndexes(rows);
  if (!header) return [];

  const out: EtfConstituent[] = [];
  for (const row of rows.slice(header.headerRowIndex + 1)) {
    const ticker = normalizeTicker(row[header.tickerIdx]);
    if (!ticker || ticker === "CASH" || ticker === "USD") continue;
    const weight = parseWeightCell(row[header.weightIdx]);
    const nameCell = header.nameIdx >= 0 ? row[header.nameIdx] : null;
    const name = typeof nameCell === "string" && nameCell.trim().length > 0 ? nameCell.trim() : null;
    out.push({ ticker, name, weight });
  }
  const dedup = new Map<string, EtfConstituent>();
  for (const row of out) {
    if (!dedup.has(row.ticker)) dedup.set(row.ticker, row);
  }
  return [...dedup.values()].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
}

function findGlobalXHeaderIndexes(rows: string[][]): { headerRowIndex: number; tickerIdx: number; weightIdx: number; nameIdx: number } | null {
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    let tickerIdx = -1;
    let weightIdx = -1;
    let nameIdx = -1;
    row.forEach((cell, i) => {
      const v = String(cell ?? "").toLowerCase().trim();
      if (tickerIdx < 0 && (v === "ticker" || v === "symbol" || v.includes("ticker symbol"))) tickerIdx = i;
      if (weightIdx < 0 && (v === "weightings" || v === "weight" || v.includes("portfolio weight") || v.includes("% net assets"))) weightIdx = i;
      if (nameIdx < 0 && (v === "name" || v === "security name" || v.includes("holding"))) nameIdx = i;
    });
    if (tickerIdx >= 0 && weightIdx >= 0) return { headerRowIndex: rowIndex, tickerIdx, weightIdx, nameIdx };
  }
  return null;
}

export function parseGlobalXDelimitedRows(raw: string): EtfConstituent[] {
  const lines = raw
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];

  const rows = lines.map((l) => splitDelimitedRow(l, ","));
  const header = findGlobalXHeaderIndexes(rows);
  if (!header) return [];

  const out: EtfConstituent[] = [];
  for (const row of rows.slice(header.headerRowIndex + 1)) {
    const ticker = normalizeGlobalXTickerCell(row[header.tickerIdx]);
    if (!ticker || ticker === "USD" || ticker === "CASH") continue;
    const weight = parseWeightCell(row[header.weightIdx]);
    const nameCell = header.nameIdx >= 0 ? row[header.nameIdx] : null;
    const name = typeof nameCell === "string" && nameCell.trim().length > 0 ? nameCell.trim() : null;
    out.push({ ticker, name, weight });
  }

  const dedup = new Map<string, EtfConstituent>();
  for (const row of out) {
    if (!dedup.has(row.ticker)) dedup.set(row.ticker, row);
  }
  return [...dedup.values()].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
}

function extractInvescoPageLinks(html: string, etfTicker: string): string[] {
  const links: string[] = [];
  const anchorRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorRegex.exec(html)) !== null) {
    const href = match[1];
    const text = match[2]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() ?? "";
    if (!/\/financial-products\/etfs\/.+\.html/i.test(href)) continue;
    const haystack = `${href} ${text}`.toUpperCase();
    const tickerPattern = new RegExp(`(^|[^A-Z0-9])${etfTicker.toUpperCase()}([^A-Z0-9]|$)`);
    if (!tickerPattern.test(haystack)) continue;
    links.push(href);
  }
  return links;
}

function extractCsvLinksFromHtml(html: string): string[] {
  const urls: string[] = [];
  const absolute = html.match(/https?:\/\/[^"'\\s>]+\.csv(?:\?[^"'\\s>]*)?/gi) ?? [];
  urls.push(...absolute);
  const hrefRegex = /href=["']([^"']+\.csv(?:\?[^"']*)?)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefRegex.exec(html)) !== null) {
    urls.push(match[1]);
  }
  return urls;
}

export function extractInvescoDownloadLinksFromHtml(html: string): string[] {
  const urls = new Set<string>();
  for (const raw of extractCsvLinksFromHtml(html)) {
    urls.add(raw);
  }
  for (const raw of extractDownloadLinksFromHtml(html)) {
    urls.add(raw);
  }

  const anchorRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorRegex.exec(html)) !== null) {
    const href = match[1] ?? "";
    const text = match[2]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().toLowerCase() ?? "";
    const hrefLower = href.toLowerCase();
    const looksLikeDownload =
      text.includes("export data") ||
      text.includes("holdings") ||
      text.includes("portfolio") ||
      text.includes("download") ||
      hrefLower.includes("export") ||
      hrefLower.includes("download") ||
      hrefLower.includes("holding") ||
      hrefLower.includes("portfolio");
    if (looksLikeDownload) urls.add(href);
  }

  return [...urls];
}

function extractDownloadLinksFromHtml(html: string): string[] {
  const urls: string[] = [];
  const absolute = html.match(/https?:\/\/[^"'\\s>]+\.(?:csv|xlsx|xls|txt)(?:\?[^"'\\s>]*)?/gi) ?? [];
  urls.push(...absolute);
  const hrefRegex = /href=["']([^"']+\.(?:csv|xlsx|xls|txt)(?:\?[^"']*)?)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefRegex.exec(html)) !== null) {
    urls.push(match[1]);
  }
  return urls;
}

function parseHtmlHoldingsRows(html: string, etfTicker: string): EtfConstituent[] {
  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) ?? [];
  const out: EtfConstituent[] = [];
  const symbolPatterns = [
    /\/quote\/([A-Z0-9.\-^]{1,20})(?:[/?#"'&<\s]|$)/i,
    /\/stocks\/([A-Z0-9.\-^]{1,20})\//i,
    /\/stock\/([A-Z0-9.\-^]{1,20})\//i,
    /<td[^>]*>\s*([A-Z0-9.\-^]{1,20})\s*<\/td>/i,
  ];
  for (const row of rows) {
    let ticker: string | null = null;
    for (const pattern of symbolPatterns) {
      const m = row.match(pattern);
      if (!m?.[1]) continue;
      const normalized = normalizeTicker(m[1]);
      if (!normalized) continue;
      ticker = normalized;
      break;
    }
    if (!ticker || ticker === etfTicker || ticker === "USD" || ticker === "CASH") continue;
    const weightMatch = row.match(/([0-9]+(?:\.[0-9]+)?)%/i);
    const anchorMatch = row.match(/<a[^>]*>([^<]+)<\/a>/i);
    out.push({
      ticker,
      name: anchorMatch?.[1]?.trim() || null,
      weight: weightMatch ? Number(weightMatch[1]) : null,
    });
  }
  const dedup = new Map<string, EtfConstituent>();
  for (const row of out) if (!dedup.has(row.ticker)) dedup.set(row.ticker, row);
  return [...dedup.values()].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
}

function parseHoldingsFileByType(url: string, contentType: string, textBody: string | null, binaryBody: ArrayBuffer | null): EtfConstituent[] {
  const lowerUrl = url.toLowerCase();
  const lowerType = contentType.toLowerCase();
  const looksWorkbook =
    lowerUrl.endsWith(".xlsx") ||
    lowerUrl.endsWith(".xls") ||
    lowerType.includes("sheet") ||
    lowerType.includes("excel") ||
    lowerType.includes("octet-stream") ||
    lowerType.includes("zip");
  if (looksWorkbook && binaryBody) {
    return parseSsgaWorkbookRows(binaryBody);
  }
  const text = textBody ?? "";
  const parsedGlobalX = parseGlobalXDelimitedRows(text);
  if (parsedGlobalX.length > 0) return parsedGlobalX;
  const parsedInvesco = parseInvescoDelimitedRows(text);
  if (parsedInvesco.length > 0) return parsedInvesco;
  const parsedSsga = parseSsgaDelimitedRows(text);
  if (parsedSsga.length > 0) return parsedSsga;
  return [];
}

function extractGlobalXCsvLinks(html: string): string[] {
  const urls = new Set<string>();
  const absolute = html.match(/https?:\/\/assets\.globalxetfs\.com\/funds\/holdings\/[^"'\\s>]+\.csv(?:\?[^"'\\s>]*)?/gi) ?? [];
  for (const url of absolute) urls.add(url);

  const hrefRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefRegex.exec(html)) !== null) {
    const href = match[1] ?? "";
    const text = match[2]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().toLowerCase() ?? "";
    if (!href.toLowerCase().includes(".csv")) continue;
    if (!text.includes("holdings") && !href.toLowerCase().includes("full-holdings")) continue;
    urls.add(href);
  }

  return [...urls];
}

async function fetchGlobalXConstituents(etfTicker: string, sourceUrl: string): Promise<EtfConstituent[]> {
  const pageRes = await fetch(sourceUrl, {
    headers: {
      "User-Agent": "market-command-centre/1.0",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!pageRes.ok) {
    throw new Error(`Global X fund page fetch failed (${pageRes.status})`);
  }
  const html = await pageRes.text();
  const csvCandidates = extractGlobalXCsvLinks(html)
    .map((raw) => normalizeCsvUrl(raw, sourceUrl))
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => {
      const aPreferred = /assets\.globalxetfs\.com\/funds\/holdings\/.+full-holdings/i.test(a) ? 1 : 0;
      const bPreferred = /assets\.globalxetfs\.com\/funds\/holdings\/.+full-holdings/i.test(b) ? 1 : 0;
      return bPreferred - aPreferred;
    });

  const errors: string[] = [];
  for (const csvUrl of csvCandidates) {
    try {
      const res = await fetch(csvUrl, {
        headers: {
          "User-Agent": "market-command-centre/1.0",
          Accept: "text/csv,application/octet-stream,*/*",
          Referer: sourceUrl,
        },
      });
      if (!res.ok) {
        errors.push(`${new URL(csvUrl).pathname} (${res.status})`);
        continue;
      }
      const parsed = parseGlobalXDelimitedRows(await res.text());
      if (parsed.length > 0) return parsed;
      errors.push(`${new URL(csvUrl).pathname} (parsed 0 rows)`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "unknown");
    }
  }
  throw new Error(`Global X holdings CSV parse returned no holdings (${errors.slice(0, 5).join(" | ")})`);
}

async function fetchOfficialConstituentsFromUrl(etfTicker: string, sourceUrl: string): Promise<EtfConstituent[]> {
  const domain = new URL(sourceUrl).hostname.toLowerCase();
  if (domain.includes("globalxetfs.com")) {
    return await fetchGlobalXConstituents(etfTicker, sourceUrl);
  }
  if (domain.includes("invesco.com")) {
    try {
      return await fetchInvescoApiConstituents(etfTicker, sourceUrl);
    } catch {
      return await fetchInvescoConstituents(etfTicker, sourceUrl);
    }
  }
  if (domain.includes("ssga.com")) {
    return await fetchSsgaFundDataConstituents(etfTicker);
  }

  const directDownload = normalizeCsvUrl(sourceUrl, sourceUrl);
  const candidates = new Set<string>();
  if (directDownload && /\.(csv|xlsx|xls|txt)(\?|$)/i.test(directDownload)) {
    candidates.add(directDownload);
  }

  const pageRes = await fetch(sourceUrl, {
    headers: {
      "User-Agent": "market-command-centre/1.0",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!pageRes.ok) {
    throw new Error(`Official source page fetch failed (${pageRes.status})`);
  }
  const pageHtml = await pageRes.text();
  for (const raw of extractDownloadLinksFromHtml(pageHtml)) {
    const normalized = normalizeCsvUrl(raw, sourceUrl);
    if (normalized) candidates.add(normalized);
  }

  const parseFromPage = parseHtmlHoldingsRows(pageHtml, etfTicker);
  if (parseFromPage.length > 0) return parseFromPage;

  const errors: string[] = [];
  for (const url of candidates) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "market-command-centre/1.0",
          Accept: "text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/octet-stream,*/*",
          Referer: sourceUrl,
        },
      });
      if (!res.ok) {
        errors.push(`${new URL(url).hostname}${new URL(url).pathname} (${res.status})`);
        continue;
      }
      const contentType = res.headers.get("content-type") ?? "";
      const lowerUrl = url.toLowerCase();
      const shouldReadBinary = lowerUrl.endsWith(".xlsx") || lowerUrl.endsWith(".xls") || /sheet|excel|octet-stream|zip/i.test(contentType);
      const parsed = shouldReadBinary
        ? parseHoldingsFileByType(url, contentType, null, await res.arrayBuffer())
        : parseHoldingsFileByType(url, contentType, await res.text(), null);
      if (parsed.length > 0) return parsed;
      errors.push(`${new URL(url).hostname}${new URL(url).pathname} (parsed 0 rows)`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "unknown");
    }
  }
  throw new Error(`Official source parse returned no holdings (${errors.slice(0, 5).join(" | ")})`);
}

function parseInvescoApiRows(rows: Array<{ ticker?: string | null; issuerName?: string | null; percentageOfTotalNetAssets?: number | null; securityTypeName?: string | null }>): EtfConstituent[] {
  const out: EtfConstituent[] = [];
  for (const row of rows) {
    const securityType = String(row.securityTypeName ?? "").toLowerCase();
    if (securityType.includes("currency") || securityType.includes("cash")) continue;
    const ticker = normalizeTicker(row.ticker ?? undefined);
    if (!ticker || ticker === "USD" || ticker === "CASH") continue;
    const weightRaw = row.percentageOfTotalNetAssets;
    const weight = typeof weightRaw === "number" && Number.isFinite(weightRaw) ? weightRaw : null;
    out.push({
      ticker,
      name: row.issuerName?.trim() || null,
      weight,
    });
  }
  const dedup = new Map<string, EtfConstituent>();
  for (const row of out) {
    if (!dedup.has(row.ticker)) dedup.set(row.ticker, row);
  }
  return [...dedup.values()].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
}

function extractInvescoHtmlMeta(html: string): { cusip: string | null; locale: string; idType: string } {
  const decode = (value: string) => value.replace(/&#34;/g, "\"").replace(/&quot;/g, "\"");
  const normalized = decode(html);
  const find = (patterns: RegExp[]): string | null => {
    for (const p of patterns) {
      const m = normalized.match(p);
      if (m?.[1]) return m[1].trim();
    }
    return null;
  };
  const cusip = find([
    /"cusip"\s*:\s*"([A-Z0-9]{9})"/i,
  ]);
  const locale = find([
    /"locale"\s*:\s*"([a-z]{2}_[A-Z]{2})"/,
  ]) ?? "en_US";
  const idType = (find([
    /"uniqueIdentifier"\s*:\s*"([a-zA-Z0-9_-]+)"/,
  ]) ?? "cusip").toLowerCase();
  return { cusip, locale, idType };
}

async function fetchInvescoApiConstituents(etfTicker: string, pageUrlOverride?: string | null): Promise<EtfConstituent[]> {
  let cusip = INVESCO_KNOWN_CUSIP_BY_TICKER[etfTicker] ?? null;
  let locale = "en_US";
  let idType = "cusip";

  if (!cusip) {
    const pageUrl = pageUrlOverride ?? INVESCO_KNOWN_PAGE_BY_TICKER[etfTicker];
    if (!pageUrl) {
      throw new Error(`No known Invesco page metadata mapping for ${etfTicker}`);
    }
    const pageRes = await fetch(pageUrl, {
      headers: {
        "User-Agent": "market-command-centre/1.0",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    if (!pageRes.ok) {
      throw new Error(`Invesco product page fetch failed (${pageRes.status})`);
    }
    const html = await pageRes.text();
    const meta = extractInvescoHtmlMeta(html);
    cusip = meta.cusip;
    locale = meta.locale;
    idType = meta.idType;
  }

  if (!cusip) throw new Error(`Could not resolve Invesco identifier for ${etfTicker}`);
  const url = `https://dng-api.invesco.com/cache/v1/accounts/${encodeURIComponent(locale)}/shareclasses/${encodeURIComponent(cusip)}/holdings/fund?idType=${encodeURIComponent(idType)}&productType=ETF`;
  const res = await fetch(url, { headers: { "User-Agent": "market-command-centre/1.0" } });
  if (!res.ok) {
    throw new Error(`Invesco holdings API failed (${res.status})`);
  }
  const json = (await res.json()) as {
    holdings?: Array<{
      ticker?: string | null;
      issuerName?: string | null;
      percentageOfTotalNetAssets?: number | null;
      securityTypeName?: string | null;
    }>;
  };
  const parsed = parseInvescoApiRows(json.holdings ?? []);
  if (parsed.length === 0) {
    throw new Error("Invesco holdings API returned no usable holdings");
  }
  return parsed;
}

async function fetchInvescoConstituents(etfTicker: string, pageUrlOverride?: string | null): Promise<EtfConstituent[]> {
  const searchPages = [
    ...INVESCO_ETF_DISCOVERY_URLS,
    `https://www.invesco.com/us/en/financial-products/etfs.html?assetClass=Equity&query=${encodeURIComponent(etfTicker)}`,
    `https://www.invesco.com/us/en/search.html?q=${encodeURIComponent(etfTicker)}`,
  ];
  const etfPageCandidates = new Set<string>();
  const knownPage = pageUrlOverride ?? INVESCO_KNOWN_PAGE_BY_TICKER[etfTicker] ?? null;
  if (knownPage) etfPageCandidates.add(knownPage);

  // If we already know the ETF page, skip broad discovery to preserve subrequest budget.
  if (!knownPage) {
    for (const url of searchPages) {
      if (etfPageCandidates.size >= 4) break;
      try {
        const res = await fetch(url, {
          headers: {
            "User-Agent": "market-command-centre/1.0",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
        });
        if (!res.ok) continue;
        const html = await res.text();
        for (const href of extractInvescoPageLinks(html, etfTicker)) {
          const normalized = normalizeCsvUrl(href, url);
          if (!normalized) continue;
          etfPageCandidates.add(normalized);
          if (etfPageCandidates.size >= 4) break;
        }
      } catch {
        // Continue with whatever URLs we already have.
      }
    }
  }

  const csvCandidates = new Set<string>();
  for (const pageUrl of [...etfPageCandidates].slice(0, 4)) {
    try {
      const pageRes = await fetch(pageUrl, {
        headers: {
          "User-Agent": "market-command-centre/1.0",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });
      if (!pageRes.ok) continue;
      const html = await pageRes.text();
      for (const raw of extractInvescoDownloadLinksFromHtml(html)) {
        const normalized = normalizeCsvUrl(raw, pageUrl);
        if (normalized) csvCandidates.add(normalized);
      }
    } catch {
      // Continue to other page candidates.
    }
  }

  const errors: string[] = [];
  for (const csvUrl of csvCandidates) {
    try {
      const res = await fetch(csvUrl, {
        headers: {
          "User-Agent": "market-command-centre/1.0",
          Accept: "text/csv,application/octet-stream,*/*",
          Referer: "https://www.invesco.com/us/en/financial-products/etfs.html",
        },
      });
      if (!res.ok) {
        errors.push(`${new URL(csvUrl).pathname} (${res.status})`);
        continue;
      }
      const contentType = res.headers.get("content-type") ?? "";
      const lowerUrl = csvUrl.toLowerCase();
      const shouldReadBinary = lowerUrl.endsWith(".xlsx") || lowerUrl.endsWith(".xls") || /sheet|excel|octet-stream|zip/i.test(contentType);
      const parsed = shouldReadBinary
        ? parseHoldingsFileByType(csvUrl, contentType, null, await res.arrayBuffer())
        : parseHoldingsFileByType(csvUrl, contentType, await res.text(), null);
      if (parsed.length > 0) return parsed;
      errors.push(`${new URL(csvUrl).pathname} (parsed 0 rows)`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "unknown");
    }
  }
  throw new Error(`Invesco holdings CSV parse returned no holdings (${errors.slice(0, 5).join(" | ")})`);
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
  const invesco = await getInvescoPreference(env, etfTicker);
  const officialUrl = await officialUrlForTicker(env, etfTicker);

  if (officialUrl) {
    source = `official:${new URL(officialUrl).hostname.replace(/^www\./i, "")}`;
    try {
      holdings = await fetchOfficialConstituentsFromUrl(etfTicker, officialUrl);
      if (holdings.length === 0) throw new Error("Official source returned no holdings");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Official source sync failed";
      errors.push(message);
      if (isTooManySubrequestsError(error)) {
        await persistSyncErrorAndThrow(env, etfTicker, source, errors);
      }
    }
  }
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

  if (holdings.length === 0 && invesco.prefer) {
    source = "invesco:holdings-api";
    try {
      holdings = await fetchInvescoApiConstituents(etfTicker, officialUrl);
      if (holdings.length === 0) throw new Error("Invesco holdings API returned no holdings");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invesco holdings API sync failed";
      errors.push(message);
      if (isTooManySubrequestsError(error)) {
        await persistSyncErrorAndThrow(env, etfTicker, source, errors);
      }
    }
    if (holdings.length === 0) {
      source = "invesco:portfolio-csv";
      try {
        holdings = await fetchInvescoConstituents(etfTicker, officialUrl);
        if (holdings.length === 0) throw new Error("Invesco returned no holdings");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invesco CSV sync failed";
        errors.push(message);
        if (isTooManySubrequestsError(error)) {
          await persistSyncErrorAndThrow(env, etfTicker, source, errors);
        }
      }
    }
  }

  if (holdings.length === 0 && invesco.strict) {
    await persistSyncErrorAndThrow(env, etfTicker, source.startsWith("invesco:") ? source : "invesco:holdings-api", errors.length > 0 ? errors : ["Invesco holdings sync failed"]);
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
