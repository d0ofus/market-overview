import type { Env } from "./types";
import * as XLSX from "xlsx";
import { ETF_CATALOG_BY_TICKER } from "./etf-catalog";
import { meteredFetch } from "./provider-usage";
import { etfHoldingsIssue, etfHoldingsDateIssue, etfHoldingAssetType, getEtfLifecycle, parseEtfHoldingsDate, ssgaCurrencyIdentity, ssgaCorporateActionIdentity, type EtfHoldingAssetType } from "./etf-holdings-quality";

export type EtfConstituent = {
  ticker: string;
  name: string | null;
  weight: number | null;
  assetType?: EtfHoldingAssetType;
};

export type EtfSourceTier = "official" | "partial" | "synthetic";
export type EtfCoverage = "full" | "partial" | "single_asset";

export type EtfSyncResult = {
  count: number;
  source: string;
  sourceUrl: string | null;
  sourceTier: EtfSourceTier;
  coverage: EtfCoverage;
  asOfDate: string | null;
  providerRecordsCount: number | null;
  expectedMinRecords: number | null;
  skippedPartialOverwrite?: boolean;
};

type EtfFetchResult = {
  holdings: EtfConstituent[];
  source: string;
  sourceUrl: string | null;
  sourceTier: EtfSourceTier;
  coverage: EtfCoverage;
  asOfDate?: string | null;
  providerRecordsCount?: number | null;
  expectedMinRecords?: number | null;
};

type ExistingEtfCacheState = {
  recordsCount: number;
  actualCount: number;
  source: string | null;
  sourceUrl: string | null;
  sourceTier: EtfSourceTier | null;
  coverage: EtfCoverage | null;
  lastSyncedAt: string | null;
  lastFullSyncedAt: string | null;
  lastPartialSyncedAt: string | null;
  asOfDate: string | null;
};

type EtfSourceResolution = {
  url: string | null;
  origin: "watchlist" | "catalog" | "derived" | "builtin" | null;
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

const SSGA_KNOWN_FUND_DATA_TICKERS = new Set([
  ...SSGA_SELECT_SECTOR_SPDR_TICKERS,
  "XTL",
  "XSD",
  "XSW",
  "XBI",
  "XHE",
  "XAR",
  "XTN",
  "XOP",
  "XME",
  "XRT",
  "XHB",
  "KBE",
  "KRE",
  "KIE",
  "KCE",
]);

const SPECIAL_OFFICIAL_URL_BY_TICKER: Record<string, string> = {
  GLD: "https://www.spdrgoldshares.com/usa/gld/",
  ARKF: "https://www.ark-funds.com/funds/arkf",
  ARKG: "https://www.ark-funds.com/funds/arkg",
  ARKK: "https://www.ark-funds.com/funds/arkk",
  ARKQ: "https://www.ark-funds.com/funds/arkq",
  BATT: "https://amplifyetfs.com/batt-holdings/",
  HACK: "https://amplifyetfs.com/hack-holdings/",
  IBIT: "https://www.ishares.com/us/products/333011/ishares-bitcoin-trust-etf",
  IAI: "https://www.ishares.com/us/products/239504/ishares-u-s-broker-dealers-securities-exchanges-etf",
  IAK: "https://www.ishares.com/us/products/239515/ishares-u-s-insurance-etf",
  IAT: "https://www.ishares.com/us/products/239521/ishares-us-regional-banks-etf",
  IDNA: "https://www.ishares.com/us/products/308878/ishares-genomics-immunology-and-healthcare-etf",
  IDRV: "https://www.ishares.com/us/products/307332/ishares-self-driving-ev-and-tech-etf-fund",
  IEO: "https://www.ishares.com/us/products/239517/ishares-us-oil-gas-exploration-production-etf",
  IFRA: "https://www.ishares.com/us/products/294315/ishares-u-s-infrastructure-etf",
  IHE: "https://www.ishares.com/us/products/239519/ishares-us-pharmaceuticals-etf",
  IRBO: "https://www.ishares.com/us/products/297905/ishares-robotics-and-artificial-intelligence-etf-fund",
  ITB: "https://www.ishares.com/us/products/239512/ishares-us-home-construction-etf",
  IYT: "https://www.ishares.com/us/products/239501/ishares-transportation-average-etf",
  MOO: "https://www.vaneck.com/us/en/investments/agribusiness-etf-moo/",
  MSOS: "https://advisorshares.com/wp-content/uploads/csv/holdings/AS_Holdings_File.csv",
  ONLN: "https://www.proshares.com/our-etfs/strategic/onln",
  PICK: "https://www.ishares.com/us/products/239655/ishares-msci-global-metals-mining-producers-etf",
  REM: "https://www.ishares.com/us/products/239543/ishares-mortgage-real-estate-capped-etf",
  RING: "https://www.ishares.com/us/products/239654/ishares-msci-global-gold-miners-etf",
  SRVR: "https://www.paceretfs.com/products/srvr",
  VOX: "https://investor.vanguard.com/investment-products/etfs/profile/vox",
  VPU: "https://investor.vanguard.com/investment-products/etfs/profile/vpu",
  WGMI: "https://coinshares.com/us/etf/wgmi/",
};

const HOLDINGS_FILE_TICKER_BY_TICKER: Record<string, string> = {
  // iShares renamed IRBO to ARTY while some seeded watchlists still carry the old ticker.
  IRBO: "ARTY",
};

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
  if (SSGA_KNOWN_FUND_DATA_TICKERS.has(etfTicker)) return true;
  // Most SPDR funds use X* symbols and can often be resolved through SSGA fund-data files.
  return /^X[A-Z]{1,5}$/.test(etfTicker);
}

function ssgaDirectFundDataUrl(etfTicker: string): string {
  return `https://www.ssga.com/library-content/products/fund-data/etfs/us/holdings-daily-us-en-${etfTicker.toLowerCase()}.xlsx`;
}

function deriveSourceUrlFromFundName(etfTicker: string, fundName: string | null): string | null {
  const name = (fundName ?? "").toLowerCase();
  const tickerLower = etfTicker.toLowerCase();
  if (!name) return null;
  if (name.includes("spdr") || shouldPreferSsgaFundData(etfTicker)) return ssgaDirectFundDataUrl(etfTicker);
  if (name.includes("global x")) return `https://www.globalxetfs.com/funds/${tickerLower}/`;
  if (name.includes("first trust")) return `https://www.ftportfolios.com/Retail/Etf/EtfHoldings.aspx?Ticker=${encodeURIComponent(etfTicker)}`;
  if (name.includes("ark ")) return `https://www.ark-funds.com/funds/${tickerLower}`;
  if (name.includes("amplify")) return `https://amplifyetfs.com/${tickerLower}-holdings/`;
  if (name.includes("pacer")) return `https://www.paceretfs.com/products/${tickerLower}`;
  if (name.includes("vanguard")) return `https://investor.vanguard.com/investment-products/etfs/profile/${tickerLower}`;
  if (name.includes("schwab")) return `https://www.schwabassetmanagement.com/allholdings/${etfTicker}`;
  if (name.includes("proshares")) return `https://www.proshares.com/our-etfs/strategic/${tickerLower}`;
  return null;
}

export async function resolveEtfSourceUrl(env: Env, etfTickerInput: string): Promise<EtfSourceResolution> {
  const etfTicker = normalizeTicker(etfTickerInput);
  if (!etfTicker) return { url: null, origin: null };
  try {
    const watchlistRow = await env.DB.prepare(
      "SELECT source_url as sourceUrl, fund_name as fundName FROM etf_watchlists WHERE ticker = ? ORDER BY list_type ASC LIMIT 1",
    )
      .bind(etfTicker)
      .first<{ sourceUrl: string | null; fundName: string | null }>();
    if (watchlistRow?.sourceUrl?.trim()) return { url: watchlistRow.sourceUrl.trim(), origin: "watchlist" };
    const special = SPECIAL_OFFICIAL_URL_BY_TICKER[etfTicker];
    if (special) return { url: special, origin: "builtin" };
    const catalog = ETF_CATALOG_BY_TICKER[etfTicker]?.exactUrl;
    if (catalog) return { url: catalog, origin: "catalog" };
    const derived = deriveSourceUrlFromFundName(etfTicker, watchlistRow?.fundName ?? null);
    if (derived) return { url: derived, origin: "derived" };
  } catch {
    // Older schema without source_url can fall back to static mappings.
  }
  const special = SPECIAL_OFFICIAL_URL_BY_TICKER[etfTicker];
  if (special) return { url: special, origin: "builtin" };
  const catalog = ETF_CATALOG_BY_TICKER[etfTicker]?.exactUrl ?? INVESCO_KNOWN_PAGE_BY_TICKER[etfTicker] ?? null;
  if (catalog) return { url: catalog, origin: ETF_CATALOG_BY_TICKER[etfTicker] ? "catalog" : "builtin" };
  if (shouldPreferSsgaFundData(etfTicker)) return { url: ssgaDirectFundDataUrl(etfTicker), origin: "derived" };
  return { url: null, origin: null };
}

async function officialUrlForTicker(env: Env, etfTicker: string): Promise<string | null> {
  const resolved = await resolveEtfSourceUrl(env, etfTicker);
  return resolved.url;
}

async function loadFundName(env: Env, etfTicker: string): Promise<string | null> {
  try {
    const row = await env.DB.prepare(
      "SELECT COALESCE((SELECT fund_name FROM etf_watchlists WHERE ticker = ? ORDER BY list_type ASC LIMIT 1), (SELECT name FROM symbols WHERE ticker = ? LIMIT 1)) as fundName",
    )
      .bind(etfTicker, etfTicker)
      .first<{ fundName: string | null }>();
    return row?.fundName ?? null;
  } catch {
    return null;
  }
}

async function getInvescoPreference(env: Env, etfTicker: string): Promise<{ prefer: boolean; strict: boolean }> {
  if (INVESCO_KNOWN_PAGE_BY_TICKER[etfTicker]) return { prefer: true, strict: true };
  const name = (await loadFundName(env, etfTicker) ?? "").toLowerCase();
  const matched = name.includes("invesco") || name.includes("powershares");
  return { prefer: matched, strict: matched };
}

function isTooManySubrequestsError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return /too many subrequests/i.test(text);
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
    return value;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.replace(/[%,$\s]/g, "");
  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  return n;
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

function parseSsgaWorkbookRows(buffer: ArrayBuffer, etfTicker?: string, requireFundIdentity = false): EtfConstituent[] {
  const workbook = XLSX.read(buffer, { type: "array" });
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    // Respect Excel percentage formatting rather than multiplying all small
    // numbers: a CSV 0.50% and a formatted Excel 0.005 both mean 0.50%.
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, blankrows: false, raw: false });
    const identified = parseFundIdentifiedRows(rows, etfTicker);
    if (identified !== null) return identified;
    if (requireFundIdentity) continue;
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

function findFlexibleHeaderIndexes(rows: string[][]): { headerRowIndex: number; tickerIdx: number; weightIdx: number; nameIdx: number } | null {
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    let tickerIdx = -1;
    let weightIdx = -1;
    let nameIdx = -1;
    row.forEach((cell, i) => {
      const v = String(cell ?? "").toLowerCase().trim();
      if (tickerIdx < 0 && (v === "ticker" || v === "symbol" || v === "stock ticker" || v.includes("ticker symbol"))) tickerIdx = i;
      if (weightIdx < 0 && (v === "weight" || v === "weight (%)" || v === "weight(%)" || v.includes("portfolio weight") || v.includes("% of net assets") || v.includes("% net assets"))) weightIdx = i;
      if (nameIdx < 0 && (v === "name" || v === "company" || v === "security description" || v === "security name" || v.includes("holding"))) nameIdx = i;
    });
    if (tickerIdx >= 0 && weightIdx >= 0) return { headerRowIndex: rowIndex, tickerIdx, weightIdx, nameIdx };
  }
  return null;
}

export function parseFlexibleDelimitedRows(raw: string): EtfConstituent[] {
  const lines = raw
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];
  const delimiter: "," | "\t" = lines.some((l) => l.includes("\t")) ? "\t" : ",";
  const rows = lines.map((l) => splitDelimitedRow(l, delimiter));
  const header = findFlexibleHeaderIndexes(rows);
  if (!header) return [];

  const out: EtfConstituent[] = [];
  for (const row of rows.slice(header.headerRowIndex + 1)) {
    const ticker = normalizeGlobalXTickerCell(row[header.tickerIdx]);
    if (!ticker || ticker === "USD" || ticker === "CASH" || ticker === "N.A" || ticker === "N/A") continue;
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

export function parseAdvisorSharesDelimitedRows(raw: string, accountSymbol: string): EtfConstituent[] {
  const lines = raw
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];
  const rows = lines.map((l) => splitDelimitedRow(l, ","));
  let headerIndex = -1;
  let accountIdx = -1;
  let tickerIdx = -1;
  let nameIdx = -1;
  let weightIdx = -1;
  for (let i = 0; i < rows.length; i += 1) {
    rows[i].forEach((cell, idx) => {
      const v = cell.toLowerCase().trim();
      if (v === "account symbol") accountIdx = idx;
      if (v === "stock ticker") tickerIdx = idx;
      if (v === "security description") nameIdx = idx;
      if (v === "portfolio weight %") weightIdx = idx;
    });
    if (accountIdx >= 0 && tickerIdx >= 0 && weightIdx >= 0) {
      headerIndex = i;
      break;
    }
  }
  if (headerIndex < 0) return [];
  const desiredAccount = accountSymbol.toUpperCase();
  const out: EtfConstituent[] = [];
  for (const row of rows.slice(headerIndex + 1)) {
    if ((row[accountIdx] ?? "").trim().toUpperCase() !== desiredAccount) continue;
    const ticker = normalizeTicker(row[tickerIdx]);
    if (!ticker || ticker === "USD" || ticker === "CASH") continue;
    const weight = parseWeightCell(row[weightIdx]);
    const name = nameIdx >= 0 && row[nameIdx]?.trim() ? row[nameIdx].trim() : null;
    out.push({ ticker, name, weight });
  }
  const dedup = new Map<string, EtfConstituent>();
  for (const row of out) if (!dedup.has(row.ticker)) dedup.set(row.ticker, row);
  return [...dedup.values()].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
}

function parseFundIdentifiedRows(rows: unknown[][], etfTicker?: string): EtfConstituent[] | null {
  for (let index = 0; index < rows.length; index++) {
    const header = rows[index].map(cell => String(cell ?? "").trim().toLowerCase());
    const fundIndex = header.findIndex(cell => ["account symbol", "fund", "fund ticker", "fund symbol"].includes(cell));
    const tickerIndex = header.findIndex(cell => ["stock ticker", "ticker", "symbol"].includes(cell));
    if (fundIndex < 0 || tickerIndex < 0) continue;
    if (!etfTicker) return [];
    const matching = rows.slice(index + 1).filter(row => String(row[fundIndex] ?? "").trim().toUpperCase() === etfTicker.toUpperCase());
    if (!matching.length) return [];
    const quote = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const csv = [rows[index], ...matching].map(row => row.map(quote).join(",")).join("\n");
    return header[fundIndex] === "account symbol" ? parseAdvisorSharesDelimitedRows(csv, etfTicker) : parseFlexibleDelimitedRows(csv);
  }
  return null;
}

export function parseCoinSharesHoldingsHtml(html: string): EtfConstituent[] {
  const text = html.replace(/<[^>]+>/g, "\n").replace(/&nbsp;/g, " ");
  const start = text.search(/Fund Holdings/i);
  if (start < 0) return [];
  const section = text.slice(start, start + 12000);
  const lines = section
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const out: EtfConstituent[] = [];
  const stopIndex = lines.findIndex((line) => /performance|premium\/discount|source:/i.test(line));
  const holdingLines = stopIndex >= 0 ? lines.slice(0, stopIndex) : lines;
  for (const line of holdingLines) {
    const m = line.match(/^(.+?)\s+([A-Z][A-Z0-9.:-]{0,14})\s+[-0-9,]+(?:\.\d+)?\s+[-0-9,]+(?:\.\d+)?$/);
    if (!m?.[1] || !m?.[2]) continue;
    const ticker = normalizeTicker(m[2].replace(/^TSXV:/i, ""));
    if (!ticker || ticker === "USD" || ticker === "CASH") continue;
    out.push({ ticker, name: m[1].trim(), weight: null });
  }
  const dedup = new Map<string, EtfConstituent>();
  for (const row of out) if (!dedup.has(row.ticker)) dedup.set(row.ticker, row);
  return [...dedup.values()];
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

export function parseHtmlHoldingsRows(html: string, etfTicker: string): EtfConstituent[] {
  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) ?? [];
  const out: EtfConstituent[] = [];
  const symbolPatterns = [
    /\/quote\/([A-Z0-9.\-^]{1,20})(?:[/?#"'&<\s]|$)/,
    /\/stocks\/([A-Z0-9.\-^]{1,20})\//,
    /\/stock\/([A-Z0-9.\-^]{1,20})\//,
    /<td[^>]*>\s*([A-Z0-9.\-^]{1,20})\s*<\/td>/,
  ];
  for (const row of rows) {
    let ticker: string | null = null;
    for (const pattern of symbolPatterns) {
      const m = row.match(pattern);
      if (!m?.[1]) continue;
      if (m[1] !== m[1].toUpperCase()) continue;
      if (/^\d+(?:\.\d+)?$/.test(m[1])) continue;
      const normalized = normalizeTicker(m[1]);
      if (!normalized) continue;
      ticker = normalized;
      break;
    }
    if (!ticker || ticker === etfTicker || ticker === "USD" || ticker === "CASH") continue;
    const weightMatch = row.match(/([0-9]+(?:\.[0-9]+)?)%/i);
    if (!weightMatch) continue;
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

export function parseHoldingsFileByType(
  url: string,
  contentType: string,
  textBody: string | null,
  binaryBody: ArrayBuffer | null,
  options: { etfTicker?: string | null } = {},
): EtfConstituent[] {
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
    return parseSsgaWorkbookRows(binaryBody, options.etfTicker ?? undefined, /^https:\/\/(?:www\.)?advisorshares\.com\//i.test(url));
  }
  const text = textBody ?? "";
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(line => line.trim());
  const delimiter = lines.some(line => line.includes("\t")) ? "\t" : ",";
  const identified = parseFundIdentifiedRows(lines.map(line => splitDelimitedRow(line, delimiter)), options.etfTicker ?? undefined);
  if (identified !== null) return identified;
  if (/^https:\/\/(?:www\.)?advisorshares\.com\//i.test(url)) return [];
  if (/^\s*(?:<!doctype html|<html)/i.test(text)) return [];
  // Consolidated issuer exports must never fall through to an unfiltered generic parser.
  if (/account symbol/i.test(text) && /stock ticker/i.test(text)) {
    return options.etfTicker ? parseAdvisorSharesDelimitedRows(text, options.etfTicker) : [];
  }
  if (options.etfTicker) {
    const parsedAdvisorShares = parseAdvisorSharesDelimitedRows(text, options.etfTicker);
    if (parsedAdvisorShares.length > 0) return parsedAdvisorShares;
  }
  const parsedGlobalX = parseGlobalXDelimitedRows(text);
  if (parsedGlobalX.length > 0) return parsedGlobalX;
  const parsedInvesco = parseInvescoDelimitedRows(text);
  if (parsedInvesco.length > 0) return parsedInvesco;
  const parsedSsga = parseSsgaDelimitedRows(text);
  if (parsedSsga.length > 0) return parsedSsga;
  const parsedFlexible = parseFlexibleDelimitedRows(text);
  if (parsedFlexible.length > 0) return parsedFlexible;
  return [];
}

export function holdingsFileAsOfDate(text: string, etfTicker?: string): string | null {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(line => line.trim());
  const rows = lines.map(line => splitDelimitedRow(line, line.includes("\t") ? "\t" : ","));
  const labeled = rows.slice(0, 20).filter(row => /\b(?:as of|as-of|asof|holdings date)\b/i.test(row[0] ?? ""))
    .flatMap(row => row.map(parseEtfHoldingsDate)).filter((date): date is string => date !== null);
  if (new Set(labeled).size === 1) return labeled[0];
  for (let index = 0; index < Math.min(rows.length, 20); index++) {
    const header = rows[index].map(cell => cell.toLowerCase().trim());
    const dateIndex = header.findIndex(cell => ["date", "as of date", "trade date", "holdings date"].includes(cell));
    const fundIndex = header.findIndex(cell => ["account symbol", "fund", "fund ticker"].includes(cell));
    if (dateIndex < 0) continue;
    const dates = rows.slice(index + 1).filter(row => fundIndex < 0 || (etfTicker && row[fundIndex]?.toUpperCase() === etfTicker))
      .map(row => parseEtfHoldingsDate(row[dateIndex])).filter((date): date is string => date !== null);
    if (dates.length && new Set(dates).size === 1) return dates[0];
  }
  return null;
}

const SPDR_GOLD_ARCHIVE = "https://api.spdrgoldshares.com/api/v1/historical-archive?exchange=NYSE&lang=en&product=gld";
export function parseSpdrGoldArchive(buffer: ArrayBuffer, now = new Date()): EtfFetchResult {
  if (buffer.byteLength > 2_000_000) throw new Error("holdings-official-file-too-large");
  const workbook = XLSX.read(buffer, { type: "array" }), sheet = workbook.Sheets["US GLD Historical Archive"];
  if (!sheet) throw new Error("holdings-gld-security-identity-invalid");
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null });
  const header = rows[0]?.map(cell => String(cell ?? "").trim()) ?? [];
  const dateIndex = header.indexOf("Date"), ouncesIndex = header.indexOf("Total Ounces of Gold in the Trust"), navIndex = header.indexOf("Total Net Asset Value in the Trust");
  if (dateIndex < 0 || ouncesIndex < 0 || navIndex < 0) throw new Error("holdings-gld-archive-columns-invalid");
  const dated = rows.slice(1).map(row => ({ row, date: parseEtfHoldingsDate(String(row[dateIndex] ?? "")) }))
    .filter((item): item is {row: unknown[]; date: string} => item.date !== null).sort((a,b) => b.date.localeCompare(a.date));
  const latest = dated[0], today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  if (!latest || latest.date > today || [latest.row[ouncesIndex], latest.row[navIndex]].some(value => typeof value !== "number" || !Number.isFinite(value) || value <= 0)) {
    throw new Error("holdings-gld-archive-observation-invalid");
  }
  return { holdings: [{ ticker: "PHYSICAL-GOLD", name: "Physical gold bullion", weight: null, assetType: "physical_commodity" }],
    source: "spdrgoldshares:physical-gold-archive", sourceUrl: SPDR_GOLD_ARCHIVE, sourceTier: "official", coverage: "single_asset",
    asOfDate: latest.date, providerRecordsCount: 1, expectedMinRecords: 1 };
}

async function fetchSpdrGoldConstituents(): Promise<EtfFetchResult> {
  const response = await fetch(SPDR_GOLD_ARCHIVE, { headers: { "User-Agent": "market-command-centre/1.0" }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`GLD official archive fetch failed (${response.status})`);
  const buffer = await response.arrayBuffer();
  return parseSpdrGoldArchive(buffer);
}

export function parseIsharesPhysicalHoldings(text: string, etfTicker: string): EtfConstituent[] {
  if (etfTicker !== "SLV" || /^\s*(?:<!doctype html|<html)/i.test(text)) return [];
  const rows = text.split(/\r?\n/).map(line => splitDelimitedRow(line, ","));
  const headerIndex = rows.findIndex(row => row.includes("Name") && row.includes("Asset Class") && row.includes("Weight (%)"));
  if (headerIndex < 0) return [];
  const header = rows[headerIndex], nameIndex = header.indexOf("Name"), assetIndex = header.indexOf("Asset Class"), weightIndex = header.indexOf("Weight (%)");
  return rows.slice(headerIndex + 1).filter(row => /^silver(?: bullion)?$/i.test(row[nameIndex] ?? "") && /^commodity$/i.test(row[assetIndex] ?? ""))
    .map(row => ({ticker: "PHYSICAL-SILVER", name: "Physical silver bullion", weight: parseWeightCell(row[weightIndex]), assetType: "physical_commodity" as const}));
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

async function fetchGlobalXConstituents(etfTicker: string, sourceUrl: string): Promise<EtfFetchResult> {
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
      if (parsed.length > 0) {
        return {
          holdings: parsed,
          source: "globalx:full-holdings",
          sourceUrl: csvUrl,
          sourceTier: "official",
          coverage: "full",
          providerRecordsCount: parsed.length,
        };
      }
      errors.push(`${new URL(csvUrl).pathname} (parsed 0 rows)`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "unknown");
    }
  }
  throw new Error(`Global X holdings CSV parse returned no holdings (${errors.slice(0, 5).join(" | ")})`);
}

function extractArkDownloadLinksFromHtml(html: string): string[] {
  const urls = new Set<string>();
  for (const raw of extractDownloadLinksFromHtml(html)) urls.add(raw);
  const anchorRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorRegex.exec(html)) !== null) {
    const href = match[1] ?? "";
    const text = match[2]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().toLowerCase() ?? "";
    if (text.includes("full holdings csv") || (text.includes("holdings") && href.toLowerCase().includes("csv"))) urls.add(href);
  }
  return [...urls];
}

function extractIsharesProductId(sourceUrl: string): string | null {
  return new URL(sourceUrl).pathname.match(/\/products\/(\d+)\//i)?.[1] ?? null;
}

async function fetchIsharesConstituents(etfTicker: string, sourceUrl: string): Promise<EtfFetchResult> {
  const productId = extractIsharesProductId(sourceUrl);
  if (!productId) throw new Error("Could not resolve iShares product id");
  if (etfTicker === "IBIT") {
    return {
      holdings: [{ ticker: "BTC", name: "Bitcoin", weight: null, assetType: "crypto" }],
      source: "ishares:single-asset",
      sourceUrl,
      sourceTier: "synthetic",
      coverage: "single_asset",
      providerRecordsCount: 1,
      expectedMinRecords: 1,
    };
  }
  const path = new URL(sourceUrl).pathname.replace(/\/$/, "");
  const origin = new URL(sourceUrl).origin;
  const holdingsFileTicker = HOLDINGS_FILE_TICKER_BY_TICKER[etfTicker] ?? etfTicker;
  const candidates = [
    `${origin}${path}/1467271812596.ajax?fileType=csv&fileName=${encodeURIComponent(holdingsFileTicker)}_holdings&dataType=fund`,
    `${origin}/us/products/${productId}/1467271812596.ajax?fileType=csv&fileName=${encodeURIComponent(holdingsFileTicker)}_holdings&dataType=fund`,
  ];
  const errors: string[] = [];
  for (const csvUrl of candidates) {
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
      const text = await res.text();
      const parsed = etfTicker === "SLV" ? parseIsharesPhysicalHoldings(text, etfTicker)
        : parseHoldingsFileByType(csvUrl, res.headers.get("content-type") ?? "", text, null, { etfTicker });
      if (parsed.length > 0) {
        return {
          holdings: parsed,
          source: "ishares:holdings-csv",
          sourceUrl: csvUrl,
          sourceTier: "official",
          coverage: etfTicker === "SLV" ? "single_asset" : "full",
          asOfDate: holdingsFileAsOfDate(text, etfTicker),
          providerRecordsCount: parsed.length,
        };
      }
      errors.push(`${new URL(csvUrl).pathname} (parsed 0 rows)`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "unknown");
    }
  }
  throw new Error(`iShares holdings CSV parse returned no holdings (${errors.slice(0, 5).join(" | ")})`);
}

async function fetchArkConstituents(etfTicker: string, sourceUrl: string): Promise<EtfFetchResult> {
  const pageRes = await fetch(sourceUrl, {
    headers: {
      "User-Agent": "market-command-centre/1.0",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!pageRes.ok) throw new Error(`ARK fund page fetch failed (${pageRes.status})`);
  const html = await pageRes.text();
  const candidates = extractArkDownloadLinksFromHtml(html)
    .map((raw) => normalizeCsvUrl(raw, sourceUrl))
    .filter((value): value is string => Boolean(value))
    .filter((url) => /holdings/i.test(url));
  const errors: string[] = [];
  for (const url of candidates) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "market-command-centre/1.0",
          Accept: "text/csv,application/octet-stream,*/*",
          Referer: sourceUrl,
        },
      });
      if (!res.ok) {
        errors.push(`${new URL(url).pathname} (${res.status})`);
        continue;
      }
      const parsed = parseHoldingsFileByType(url, res.headers.get("content-type") ?? "", await res.text(), null, { etfTicker });
      if (parsed.length > 0) {
        return {
          holdings: parsed,
          source: "ark:full-holdings",
          sourceUrl: url,
          sourceTier: "official",
          coverage: "full",
          providerRecordsCount: parsed.length,
        };
      }
      errors.push(`${new URL(url).pathname} (parsed 0 rows)`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "unknown");
    }
  }
  throw new Error(`ARK holdings CSV parse returned no holdings (${errors.slice(0, 5).join(" | ")})`);
}

async function fetchCoinSharesConstituents(etfTicker: string, sourceUrl: string): Promise<EtfFetchResult> {
  const res = await fetch(sourceUrl, {
    headers: {
      "User-Agent": "market-command-centre/1.0",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!res.ok) throw new Error(`CoinShares fund page fetch failed (${res.status})`);
  const html = await res.text();
  const parsed = parseCoinSharesHoldingsHtml(html);
  if (parsed.length === 0) throw new Error("CoinShares page returned no parsable holdings");
  const totalMatch = html.match(/#\s*of\s*Holdings[\s\S]{0,200}?(\d{1,4})/i) ?? html.match(/total:\s*(\d{1,4})\s*entries/i);
  const expected = totalMatch?.[1] ? Number(totalMatch[1]) : null;
  return {
    holdings: parsed,
    source: "coinshares:holdings-page",
    sourceUrl,
    sourceTier: expected && parsed.length >= expected ? "official" : "partial",
    coverage: expected && parsed.length >= expected ? "full" : "partial",
    providerRecordsCount: parsed.length,
    expectedMinRecords: expected,
  };
}

async function fetchOfficialConstituentsFromUrl(etfTicker: string, sourceUrl: string): Promise<EtfFetchResult> {
  const domain = new URL(sourceUrl).hostname.toLowerCase();
  if (etfTicker === "GLD") return fetchSpdrGoldConstituents();
  if (etfTicker === "IBIT") {
    return await fetchIsharesConstituents(etfTicker, sourceUrl);
  }
  if (domain.includes("globalxetfs.com")) {
    return await fetchGlobalXConstituents(etfTicker, sourceUrl);
  }
  if (domain.includes("ishares.com") || domain.includes("blackrock.com")) {
    return await fetchIsharesConstituents(etfTicker, sourceUrl);
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
  if (domain.includes("ark-funds.com")) {
    return await fetchArkConstituents(etfTicker, sourceUrl);
  }
  if (domain.includes("coinshares.com") || domain.includes("valkyrie")) {
    return await fetchCoinSharesConstituents(etfTicker, sourceUrl);
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
  // A liquidated/renamed product may redirect to an issuer directory. Never
  // treat that directory's downloads as the requested fund's full holdings.
  if (pageRes.url && /\/etfs\/[a-z0-9-]+\/?$/i.test(new URL(sourceUrl).pathname)
    && !new URL(pageRes.url).pathname.toLowerCase().split("/").includes(etfTicker.toLowerCase())) {
    throw new Error("holdings-official-page-identity-changed");
  }
  const pageHtml = await pageRes.text();
  for (const raw of extractDownloadLinksFromHtml(pageHtml)) {
    const normalized = normalizeCsvUrl(raw, sourceUrl);
    if (normalized && new URL(normalized).hostname.replace(/^www\./, "") === domain.replace(/^www\./, "")) candidates.add(normalized);
  }

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
      const binary = shouldReadBinary ? await res.arrayBuffer() : null, text = shouldReadBinary ? null : await res.text();
      const parsed = parseHoldingsFileByType(url, contentType, text, binary, { etfTicker });
      if (parsed.length > 0) {
        return {
          holdings: parsed,
          source: `official:${domain.replace(/^www\./i, "")}`,
          sourceUrl: url,
          sourceTier: "official",
          coverage: "full",
          providerRecordsCount: parsed.length,
          asOfDate: text === null ? null : holdingsFileAsOfDate(text, etfTicker),
        };
      }
      errors.push(`${new URL(url).hostname}${new URL(url).pathname} (parsed 0 rows)`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "unknown");
    }
  }
  const parseFromPage = parseHtmlHoldingsRows(pageHtml, etfTicker);
  if (parseFromPage.length > 0) {
    return {
      holdings: parseFromPage,
      source: `official:${domain.replace(/^www\./i, "")}:html`,
      sourceUrl,
      sourceTier: ["ftportfolios.com", "vaneck.com", "coinshares.com"].some((host) => domain.includes(host)) ? "official" : "partial",
      coverage: ["ftportfolios.com", "vaneck.com", "coinshares.com"].some((host) => domain.includes(host)) ? "full" : "partial",
      providerRecordsCount: parseFromPage.length,
    };
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

async function fetchInvescoApiConstituents(etfTicker: string, pageUrlOverride?: string | null): Promise<EtfFetchResult> {
  let cusip: string | null = INVESCO_KNOWN_CUSIP_BY_TICKER[etfTicker] ?? null;
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
  return {
    holdings: parsed,
    source: "invesco:holdings-api",
    sourceUrl: url,
    sourceTier: "official",
    coverage: "full",
    providerRecordsCount: parsed.length,
  };
}

async function fetchInvescoConstituents(etfTicker: string, pageUrlOverride?: string | null): Promise<EtfFetchResult> {
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
        ? parseHoldingsFileByType(csvUrl, contentType, null, await res.arrayBuffer(), { etfTicker })
        : parseHoldingsFileByType(csvUrl, contentType, await res.text(), null, { etfTicker });
      if (parsed.length > 0) {
        return {
          holdings: parsed,
          source: "invesco:portfolio-csv",
          sourceUrl: csvUrl,
          sourceTier: "official",
          coverage: "full",
          providerRecordsCount: parsed.length,
        };
      }
      errors.push(`${new URL(csvUrl).pathname} (parsed 0 rows)`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "unknown");
    }
  }
  throw new Error(`Invesco holdings CSV parse returned no holdings (${errors.slice(0, 5).join(" | ")})`);
}

const SSGA_MAX_FILE_BYTES = 2_000_000;
const SSGA_MAX_HOLDINGS_FILES = 4;

function ssgaHoldingsUrl(value: string, etfTicker: string): string | null {
  try {
    const url = new URL(value.replace(/&amp;/g, "&"), "https://www.ssga.com");
    const match = /^\/library-content\/products\/fund-data\/etfs\/us\/(?:holdings-daily|fund-holdings)-us-en-([a-z0-9.-]+)\.(xlsx|csv)$/i.exec(url.pathname);
    if (url.protocol !== "https:" || url.hostname !== "www.ssga.com" || url.port || url.username || url.password
      || !match || match[1].toUpperCase() !== etfTicker.toUpperCase()) return null;
    // Query strings are not part of these public static holdings identities.
    return `${url.origin}${url.pathname}`;
  } catch { return null; }
}

export function extractSsgaHoldingsLinks(html: string, etfTicker: string): string[] {
  const matches = html.match(/(?:https?:\/\/[^"'\s<>]+|\/library-content\/[^"'\s<>]+)\.(?:xlsx|csv)(?:\?[^"'\s<>]*)?/gi) ?? [];
  return [...new Set(matches.map(value => ssgaHoldingsUrl(value, etfTicker)).filter((value): value is string => value !== null))]
    .sort((a, b) => Number(b.endsWith(".xlsx")) - Number(a.endsWith(".xlsx"))).slice(0, SSGA_MAX_HOLDINGS_FILES);
}

/** SSGA's dated, single-fund holdings export. Performance/NAV workbooks and
 * missing fund/date evidence cannot be accepted as a current full snapshot. */
export function parseSsgaHoldingsFile(etfTicker: string, buffer: ArrayBuffer, kind: "xlsx" | "csv") {
  if (!buffer.byteLength || buffer.byteLength > SSGA_MAX_FILE_BYTES) throw new Error("ssga-holdings-file-size-invalid");
  let rows: unknown[][];
  if (kind === "xlsx") {
    const signature = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
    if (signature.length !== 4 || signature[0] !== 0x50 || signature[1] !== 0x4b || signature[2] !== 3 || signature[3] !== 4) {
      throw new Error("ssga-holdings-workbook-invalid");
    }
    const workbook = XLSX.read(buffer, { type: "array" });
    const sheets = workbook.SheetNames.filter(name => /^holdings$/i.test(name.trim()));
    if (sheets.length !== 1) throw new Error("ssga-holdings-sheet-missing");
    rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheets[0]], { header: 1, defval: null, blankrows: false, raw: false });
  } else {
    const text = new TextDecoder().decode(buffer);
    if (/^\s*</.test(text)) throw new Error("ssga-holdings-csv-invalid");
    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(line => line.trim());
    const delimiter = lines.some(line => line.includes("\t")) ? "\t" : ",";
    rows = lines.map(line => splitDelimitedRow(line, delimiter));
  }
  const metadata = rows.slice(0, 20);
  const fundRows = metadata.filter(row => /^ticker(?: symbol)?\s*:?$/i.test(String(row[0] ?? "").trim()));
  if (fundRows.length !== 1 || String(fundRows[0][1] ?? "").trim().toUpperCase() !== etfTicker.toUpperCase()) {
    throw new Error("ssga-holdings-fund-identity-invalid");
  }
  const datedRows = metadata.filter(row => /^(?:holdings|holdings as of|as of|holdings date)\s*:?$/i.test(String(row[0] ?? "").trim()));
  const dates = datedRows.flatMap(row => row.map(parseEtfHoldingsDate)).filter((date): date is string => date !== null);
  if (!dates.length || new Set(dates).size !== 1) throw new Error("ssga-holdings-effective-date-unavailable");
  const asOfDate = dates[0];
  const dateIssue = etfHoldingsDateIssue([asOfDate]);
  if (dateIssue) throw new Error(dateIssue);
  const header = findSsgaHeaderIndexes(rows);
  if (!header) throw new Error("ssga-holdings-header-missing");
  const identifierIndex = rows[header.headerRowIndex].findIndex(value => String(value ?? "").trim().toLowerCase() === "identifier");
  const holdings: EtfConstituent[] = [];
  for (const row of rows.slice(header.headerRowIndex + 1)) {
    let ticker = normalizeTicker(String(row[header.tickerIdx] ?? ""));
    // Footer prose has no position weight. A weighted row with no identity is
    // missing coverage, not permission to silently drop a reported position.
    const weight = parseWeightCell(row[header.weightIdx]);
    if (!ticker) {
      if (weight !== null) throw new Error("ssga-holdings-position-identity-invalid");
      continue;
    }
    const name = header.nameIdx >= 0 ? String(row[header.nameIdx] ?? "").trim() : "";
    // Preserve currency and nontradable source identities rather than treating
    // every '-' position as the same security or silently dropping it.
    if (ticker === "-") ticker = ssgaCurrencyIdentity(name) ?? ticker;
    if (ticker === "-") ticker = ssgaCorporateActionIdentity(etfTicker, name, String(row[identifierIndex] ?? "").trim()) ?? ticker;
    const assetType = etfHoldingAssetType(etfTicker, { ticker, name, source: "ssga:fund-data" });
    if ((ticker === "-" && assetType !== "money_market") || weight === null) throw new Error("ssga-holdings-position-identity-invalid");
    holdings.push({ ticker, name: name || null, weight, assetType });
  }
  const issue = etfHoldingsIssue(etfTicker, holdings.map(row => ({ ...row, source: "ssga:fund-data" })));
  if (!holdings.length || issue) throw new Error(issue ?? "ssga-holdings-empty");
  return { holdings, asOfDate };
}

async function readSsgaBody(response: Response): Promise<ArrayBuffer> {
  if (Number(response.headers.get("content-length")) > SSGA_MAX_FILE_BYTES) throw new Error("ssga-holdings-file-size-invalid");
  if (!response.body) throw new Error("ssga-holdings-body-unavailable");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > SSGA_MAX_FILE_BYTES) throw new Error("ssga-holdings-file-size-invalid");
      chunks.push(chunk.value);
    }
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  finally { reader.releaseLock(); }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result.buffer;
}

export async function fetchSsgaFundDataConstituents(etfTicker: string): Promise<EtfFetchResult> {
  const pageUrl = SSGA_SPDR_PAGE_BY_TICKER[etfTicker] ?? null;
  const deadline = AbortSignal.timeout(45_000);
  const headers = { "User-Agent": "market-command-centre/1.0", Referer: pageUrl ?? "https://www.ssga.com/" };
  const errors: string[] = [];
  let pageCandidates: string[] = [];
  if (pageUrl) {
    try {
      const response = await fetch(pageUrl, { headers: { ...headers, Accept: "text/html" }, signal: AbortSignal.any([deadline, AbortSignal.timeout(8_000)]) });
      if (response.status === 403 || response.status === 429) {
        await response.body?.cancel();
        throw new Error(`ssga-source-cooldown-http-${response.status}`);
      }
      if (response.ok && (!response.url || new URL(response.url).hostname === "www.ssga.com")) {
        pageCandidates = extractSsgaHoldingsLinks(new TextDecoder().decode(await readSsgaBody(response)), etfTicker);
      } else { await response.body?.cancel(); }
    } catch (error) {
      if (error instanceof Error && /ssga-source-cooldown|holdings-operator-/.test(error.message)) throw error;
      errors.push("ssga-holdings-page-unavailable");
    }
  }
  const primary = ssgaDirectFundDataUrl(etfTicker);
  const candidates = [...new Set([...pageCandidates.filter(url => url.endsWith(".xlsx")), primary,
    ...pageCandidates.filter(url => url.endsWith(".csv")), primary.replace(/\.xlsx$/, ".csv")])].slice(0, SSGA_MAX_HOLDINGS_FILES);
  for (const url of candidates) {
    if (deadline.aborted) break;
    try {
      const response = await fetch(url, { headers: { ...headers, Accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" },
        signal: AbortSignal.any([deadline, AbortSignal.timeout(8_000)]) });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 403 || response.status === 429) throw new Error(`ssga-source-cooldown-http-${response.status}`);
        errors.push(`ssga-holdings-http-${response.status}`); continue;
      }
      if (response.url && !ssgaHoldingsUrl(response.url, etfTicker)) throw new Error("ssga-holdings-redirect-identity-invalid");
      const parsed = parseSsgaHoldingsFile(etfTicker, await readSsgaBody(response), url.endsWith(".xlsx") ? "xlsx" : "csv");
      return { ...parsed, source: "ssga:fund-data", sourceUrl: url, sourceTier: "official", coverage: "full", providerRecordsCount: parsed.holdings.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : "ssga-holdings-request-unavailable";
      if (/ssga-source-cooldown|holdings-operator-/.test(message)) throw error;
      errors.push(/^(?:ssga-|holdings-)[a-z-]+$/.test(message) ? message : "ssga-holdings-request-unavailable");
    }
  }
  throw new Error(`SSGA holdings unavailable (${[...new Set(errors)].join(" | ")})`);
}

const yahooHoldingsQueues = new WeakMap<Env, { lastStartedAt: number; pending: Promise<void> }>();
async function requestYahooHoldings(env: Env, url: string): Promise<Response> {
  let queue = yahooHoldingsQueues.get(env);
  if (!queue) {
    queue = { lastStartedAt: 0, pending: Promise.resolve() };
    yahooHoldingsQueues.set(env, queue);
  }
  const state = queue;
  const request = state.pending.then(async () => {
    const wait = Math.max(0, 2_000 - (Date.now() - state.lastStartedAt));
    if (wait) await new Promise<void>(resolve => setTimeout(resolve, wait));
    state.lastStartedAt = Date.now();
    return meteredFetch(env, url, { headers: { "User-Agent": "market-command-centre/1.0" } },
      { providerKey: "yahoo", endpointKey: "etf-top-holdings", caller: "etf-constituents", symbolCount: 1 }, 8_000);
  });
  state.pending = request.then(() => undefined, () => undefined);
  return request;
}

async function fetchYahooConstituents(env: Env, etfTicker: string): Promise<EtfFetchResult> {
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(etfTicker)}?modules=topHoldings`;
  // Share the Yahoo daily reservation with EOD prices and every other metered
  // caller. Each actual fallback attempt is charged, including later retries;
  // a blocked reservation sends no Yahoo request and preserves other fallbacks.
  const res = await requestYahooHoldings(env, url);
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
  return {
    holdings: out,
    source: "yahoo:topHoldings",
    sourceUrl: url,
    sourceTier: "partial",
    coverage: "partial",
    providerRecordsCount: out.length,
  };
}

function extractStockAnalysisExpectedCount(html: string): number | null {
  const showing = html.match(/Showing\s+\d+\s+of\s+(\d+)\s+holdings/i);
  if (showing?.[1]) return Number(showing[1]);
  const total = html.match(/total\s+of\s+(\d+)\s+individual\s+holdings/i);
  if (total?.[1]) return Number(total[1]);
  return null;
}

async function fetchStockAnalysisConstituents(etfTicker: string): Promise<EtfFetchResult> {
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
  const holdings = [...dedup.values()];
  return {
    holdings,
    source: "stockanalysis:holdings-page",
    sourceUrl: url,
    sourceTier: "partial",
    coverage: "partial",
    providerRecordsCount: holdings.length,
    expectedMinRecords: extractStockAnalysisExpectedCount(html),
  };
}

async function fetchEtfDbConstituents(etfTicker: string): Promise<EtfFetchResult> {
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
  const holdings = [...dedup.values()];
  return {
    holdings,
    source: "etfdb:holdings-page",
    sourceUrl: url,
    sourceTier: "partial",
    coverage: "partial",
    providerRecordsCount: holdings.length,
  };
}

async function loadExistingEtfCacheState(env: Env, etfTicker: string): Promise<ExistingEtfCacheState> {
  const actual = await env.DB.prepare(
    "SELECT COUNT(*) as count, MAX(as_of_date) as asOfDate FROM etf_constituents WHERE etf_ticker = ?",
  )
    .bind(etfTicker)
    .first<{ count: number | null; asOfDate: string | null }>()
    .catch(() => null);
  try {
    const row = await env.DB.prepare(
      "SELECT records_count as recordsCount, source, source_url as sourceUrl, source_tier as sourceTier, coverage, last_synced_at as lastSyncedAt, last_full_synced_at as lastFullSyncedAt, last_partial_synced_at as lastPartialSyncedAt FROM etf_constituent_sync_status WHERE etf_ticker = ?",
    )
      .bind(etfTicker)
      .first<{
        recordsCount: number | null;
        source: string | null;
        sourceUrl: string | null;
        sourceTier: EtfSourceTier | null;
        coverage: EtfCoverage | null;
        lastSyncedAt: string | null;
        lastFullSyncedAt: string | null;
        lastPartialSyncedAt: string | null;
      }>();
    return {
      recordsCount: Number(row?.recordsCount ?? 0),
      actualCount: Number(actual?.count ?? 0),
      source: row?.source ?? null,
      sourceUrl: row?.sourceUrl ?? null,
      sourceTier: row?.sourceTier ?? null,
      coverage: row?.coverage ?? null,
      lastSyncedAt: row?.lastSyncedAt ?? null,
      lastFullSyncedAt: row?.lastFullSyncedAt ?? null,
      lastPartialSyncedAt: row?.lastPartialSyncedAt ?? null,
      asOfDate: actual?.asOfDate ?? null,
    };
  } catch {
    const row = await env.DB.prepare(
      "SELECT records_count as recordsCount, source, last_synced_at as lastSyncedAt FROM etf_constituent_sync_status WHERE etf_ticker = ?",
    )
      .bind(etfTicker)
      .first<{ recordsCount: number | null; source: string | null; lastSyncedAt: string | null }>()
      .catch(() => null);
    return {
      recordsCount: Number(row?.recordsCount ?? 0),
      actualCount: Number(actual?.count ?? 0),
      source: row?.source ?? null,
      sourceUrl: null,
      sourceTier: null,
      coverage: null,
      lastSyncedAt: row?.lastSyncedAt ?? null,
      lastFullSyncedAt: null,
      lastPartialSyncedAt: null,
      asOfDate: actual?.asOfDate ?? null,
    };
  }
}

function existingCacheLooksFull(state: ExistingEtfCacheState): boolean {
  const count = Math.max(state.actualCount, state.recordsCount);
  if (count <= 0) return false;
  if (state.coverage === "full" || state.coverage === "single_asset") return true;
  if (state.sourceTier === "official" || state.sourceTier === "synthetic") return true;
  const source = String(state.source ?? "").toLowerCase();
  return /^(official:|ssga:|invesco:|globalx:|ishares:|ark:|vaneck:|ftportfolios:|advisorshares:)/.test(source);
}

async function persistSyncStatus(env: Env, input: {
  etfTicker: string;
  status: "ok" | "error" | "partial";
  error: string | null;
  source: string;
  recordsCount: number;
  sourceUrl: string | null;
  sourceTier: EtfSourceTier | null;
  coverage: EtfCoverage | null;
  providerRecordsCount: number | null;
  expectedMinRecords: number | null;
  lastFullSyncedAt: string | null;
  lastPartialSyncedAt: string | null;
  syncedAt: string;
}): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO etf_constituent_sync_status (
         etf_ticker, last_synced_at, status, error, source, records_count, updated_at,
         coverage, source_tier, source_url, provider_records_count, expected_min_records,
         last_full_synced_at, last_partial_synced_at
       ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(etf_ticker) DO UPDATE SET
         last_synced_at = excluded.last_synced_at,
         status = excluded.status,
         error = excluded.error,
         source = excluded.source,
         records_count = excluded.records_count,
         updated_at = CURRENT_TIMESTAMP,
         coverage = excluded.coverage,
         source_tier = excluded.source_tier,
         source_url = excluded.source_url,
         provider_records_count = excluded.provider_records_count,
         expected_min_records = excluded.expected_min_records,
         last_full_synced_at = COALESCE(excluded.last_full_synced_at, etf_constituent_sync_status.last_full_synced_at),
         last_partial_synced_at = COALESCE(excluded.last_partial_synced_at, etf_constituent_sync_status.last_partial_synced_at)`,
    )
      .bind(
        input.etfTicker,
        input.syncedAt,
        input.status,
        input.error,
        input.source,
        input.recordsCount,
        input.coverage,
        input.sourceTier,
        input.sourceUrl,
        input.providerRecordsCount,
        input.expectedMinRecords,
        input.lastFullSyncedAt,
        input.lastPartialSyncedAt,
      )
      .run();
  } catch {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO etf_constituent_sync_status (etf_ticker, last_synced_at, status, error, source, records_count, updated_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
    )
      .bind(input.etfTicker, input.syncedAt, input.status === "partial" ? "ok" : input.status, input.error, input.source, input.recordsCount)
      .run();
  }
}

async function persistSyncErrorAndThrow(
  env: Env,
  etfTicker: string,
  source: string,
  errors: string[],
): Promise<never> {
  const dedupErrors = Array.from(new Set(errors));
  const message = `No constituents returned for ${etfTicker}. Source errors: ${dedupErrors.join(" | ")}`.slice(0, 700);
  const now = new Date().toISOString();
  const existing = await loadExistingEtfCacheState(env, etfTicker);
  await persistSyncStatus(env, {
    etfTicker,
    syncedAt: now,
    status: "error",
    error: message,
    source: existing.actualCount > 0 ? existing.source ?? source : source,
    recordsCount: Math.max(existing.actualCount, existing.recordsCount),
    sourceUrl: existing.sourceUrl,
    sourceTier: existing.sourceTier,
    coverage: existing.coverage,
    providerRecordsCount: existing.recordsCount || null,
    expectedMinRecords: null,
    lastFullSyncedAt: existing.lastFullSyncedAt,
    lastPartialSyncedAt: existing.lastPartialSyncedAt,
  });
  throw new Error(message);
}

function toSyncResult(fetchResult: EtfFetchResult, count = fetchResult.holdings.length, skippedPartialOverwrite = false): EtfSyncResult {
  return {
    count,
    source: fetchResult.source,
    sourceUrl: fetchResult.sourceUrl,
    sourceTier: fetchResult.sourceTier,
    coverage: fetchResult.coverage,
    asOfDate: fetchResult.asOfDate ?? null,
    providerRecordsCount: fetchResult.providerRecordsCount ?? fetchResult.holdings.length,
    expectedMinRecords: fetchResult.expectedMinRecords ?? null,
    skippedPartialOverwrite,
  };
}

function checkedEtfResult(etfTicker: string, result: EtfFetchResult): EtfFetchResult {
  if (!result.holdings.length) throw new Error("holdings-source-empty");
  const issue = etfHoldingsIssue(etfTicker, result.holdings.map(row => ({ ...row, source: result.source })))
    ?? etfHoldingsDateIssue([result.asOfDate]);
  if (issue) throw new Error(issue);
  return result;
}

export async function syncEtfConstituents(env: Env, etfTickerInput: string): Promise<EtfSyncResult> {
  const etfTicker = normalizeTicker(etfTickerInput);
  if (!etfTicker) throw new Error("Invalid ETF ticker");
  let source = "unknown";
  let result: EtfFetchResult | null = null;
  const errors: string[] = [];
  const invesco = await getInvescoPreference(env, etfTicker);
  const officialUrl = await officialUrlForTicker(env, etfTicker);
  const existing = await loadExistingEtfCacheState(env, etfTicker);
  const lifecycle = getEtfLifecycle(etfTicker);
  if (lifecycle && new Date().toISOString().slice(0, 10) >= lifecycle.liquidationDate) {
    await persistSyncErrorAndThrow(env, etfTicker, "official:fund-liquidated", [
      `${etfTicker} last traded ${lifecycle.lastTradingDate}; liquidated ${lifecycle.liquidationDate}. Historical holdings are retained; current holdings are unavailable.`,
    ]);
  }

  const ssgaAttempted = officialUrl !== null && new URL(officialUrl).hostname === "www.ssga.com";
  if (officialUrl) {
    source = `official:${new URL(officialUrl).hostname.replace(/^www\./i, "")}`;
    try {
      result = checkedEtfResult(etfTicker, await fetchOfficialConstituentsFromUrl(etfTicker, officialUrl));
      if (result.holdings.length === 0) throw new Error("Official source returned no holdings");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Official source sync failed";
      errors.push(message);
      if (isTooManySubrequestsError(error)) {
        await persistSyncErrorAndThrow(env, etfTicker, source, errors);
      }
    }
  }
  // These trusts own physical assets. A stock-list fallback is not the same
  // instrument and cannot replace a failed official bullion observation.
  if (!result && (etfTicker === "GLD" || etfTicker === "SLV")) {
    await persistSyncErrorAndThrow(env, etfTicker, source, errors);
  }
  if (!result && !ssgaAttempted && shouldPreferSsgaFundData(etfTicker)) {
    source = "ssga:fund-data";
    try {
      result = checkedEtfResult(etfTicker, await fetchSsgaFundDataConstituents(etfTicker));
      if (result.holdings.length === 0) throw new Error("SSGA returned no holdings");
    } catch (error) {
      const message = error instanceof Error ? error.message : "SSGA sync failed";
      errors.push(message);
      if (isTooManySubrequestsError(error)) {
        await persistSyncErrorAndThrow(env, etfTicker, source, errors);
      }
    }
  }

  if (!result && invesco.prefer) {
    source = "invesco:holdings-api";
    try {
      result = checkedEtfResult(etfTicker, await fetchInvescoApiConstituents(etfTicker, officialUrl));
      if (result.holdings.length === 0) throw new Error("Invesco holdings API returned no holdings");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invesco holdings API sync failed";
      errors.push(message);
      if (isTooManySubrequestsError(error)) {
        await persistSyncErrorAndThrow(env, etfTicker, source, errors);
      }
    }
    if (!result) {
      source = "invesco:portfolio-csv";
      try {
        result = checkedEtfResult(etfTicker, await fetchInvescoConstituents(etfTicker, officialUrl));
        if (result.holdings.length === 0) throw new Error("Invesco returned no holdings");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invesco CSV sync failed";
        errors.push(message);
        if (isTooManySubrequestsError(error)) {
          await persistSyncErrorAndThrow(env, etfTicker, source, errors);
        }
      }
    }
  }

  if (!result && invesco.strict) {
    await persistSyncErrorAndThrow(env, etfTicker, source.startsWith("invesco:") ? source : "invesco:holdings-api", errors.length > 0 ? errors : ["Invesco holdings sync failed"]);
  }

  if (!result) {
    source = "yahoo:topHoldings";
    try {
      result = checkedEtfResult(etfTicker, await fetchYahooConstituents(env, etfTicker));
      if (result.holdings.length === 0) throw new Error("Yahoo returned no holdings");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Yahoo sync failed";
      errors.push(message);
      if (isTooManySubrequestsError(error)) {
        await persistSyncErrorAndThrow(env, etfTicker, source, errors);
      }
    }
  }

  if (!result) {
    source = "stockanalysis:holdings-page";
    try {
      result = checkedEtfResult(etfTicker, await fetchStockAnalysisConstituents(etfTicker));
      if (result.holdings.length === 0) throw new Error("StockAnalysis returned no holdings");
    } catch (error) {
      const message = error instanceof Error ? error.message : "StockAnalysis sync failed";
      errors.push(message);
      if (isTooManySubrequestsError(error)) {
        await persistSyncErrorAndThrow(env, etfTicker, source, errors);
      }
    }
  }

  if (!result) {
    source = "etfdb:holdings-page";
    try {
      result = checkedEtfResult(etfTicker, await fetchEtfDbConstituents(etfTicker));
      if (result.holdings.length === 0) throw new Error("ETFdb returned no holdings");
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "ETFdb sync failed");
    }
  }

  if (result && result.source !== "ssga:fund-data" && shouldPreferSsgaFundData(etfTicker) && result.sourceTier !== "official") {
    result = { ...result, source: `${result.source} (ssga-preferred-fallback)` };
  }

  if (!result || result.holdings.length === 0) {
    await persistSyncErrorAndThrow(env, etfTicker, source, errors);
    throw new Error("ETF sync failed");
  }
  const finalResult = result;

  const now = new Date().toISOString();
  const asOfDate = finalResult.asOfDate ?? null;
  const isPartial = finalResult.coverage === "partial" || finalResult.sourceTier === "partial";
  if (isPartial && existingCacheLooksFull(existing)) {
    const retainedCount = existing.actualCount;
    await persistSyncStatus(env, {
      etfTicker,
      syncedAt: now,
      status: "partial",
      error: `Latest provider returned partial holdings (${finalResult.holdings.length}); retaining the last full holdings from ${existing.lastFullSyncedAt ?? existing.asOfDate ?? "an unverified date"}.`,
      source: existing.source ?? finalResult.source,
      recordsCount: retainedCount,
      sourceUrl: existing.sourceUrl ?? finalResult.sourceUrl,
      sourceTier: existing.sourceTier ?? "official",
      coverage: existing.coverage ?? "full",
      providerRecordsCount: finalResult.providerRecordsCount ?? finalResult.holdings.length,
      expectedMinRecords: finalResult.expectedMinRecords ?? null,
      lastFullSyncedAt: existing.lastFullSyncedAt,
      lastPartialSyncedAt: now,
    });
    return {
      ...toSyncResult(finalResult, retainedCount, true),
      source: existing.source ?? finalResult.source,
      sourceUrl: existing.sourceUrl ?? finalResult.sourceUrl,
      sourceTier: existing.sourceTier ?? "official",
      coverage: existing.coverage ?? "full",
      asOfDate: existing.asOfDate,
    };
  }

  const holdings = finalResult.holdings;
  if (!Number.isSafeInteger(existing.actualCount) || existing.actualCount < 0 || existing.actualCount > 10_000) {
    await persistSyncErrorAndThrow(env, etfTicker, finalResult.source, ["holdings-existing-count-limit"]);
  }
  const payload = JSON.stringify(holdings.map(h => ({ id: crypto.randomUUID(), ticker: h.ticker,
    name: h.name ?? null, weight: h.weight, assetType: etfHoldingAssetType(etfTicker, { ...h, source: finalResult.source }) })));
  // Both inserts share this bounded input. Keep the complete replacement in one
  // transaction, including symbol seeding, regardless of constituent count.
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength * 2
    + new TextEncoder().encode(JSON.stringify([etfTicker, asOfDate, finalResult.source])).byteLength * 2 > 2_000_000 - 4096) {
    await persistSyncErrorAndThrow(env, etfTicker, finalResult.source, ["holdings-persistence-payload-limit"]);
  }
  const statements = [
    // A concurrent larger replacement must abort the entire transaction before
    // exceeding its admitted delete budget. Malformed JSON deliberately aborts.
    env.DB.prepare(`DELETE FROM etf_constituents WHERE etf_ticker = ? AND
      CASE WHEN (SELECT COUNT(*) FROM etf_constituents WHERE etf_ticker = ?) <= ?
      THEN 1 ELSE json_extract('holdings-concurrent-size-changed', '$') END /* etf-holdings-replace-delete */`)
      .bind(etfTicker, etfTicker, existing.actualCount),
    env.DB.prepare(`INSERT INTO etf_constituents
      (id, etf_ticker, constituent_ticker, constituent_name, weight, as_of_date, source, updated_at)
      SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.ticker'), json_extract(value, '$.name'),
        json_extract(value, '$.weight'), ?, ?, CURRENT_TIMESTAMP FROM json_each(?) /* etf-holdings-replace-insert */`)
      .bind(etfTicker, asOfDate, finalResult.source, payload),
    env.DB.prepare(`INSERT OR IGNORE INTO symbols (ticker, name, exchange, asset_class)
      SELECT json_extract(value, '$.ticker'), COALESCE(json_extract(value, '$.name'), json_extract(value, '$.ticker')),
        NULL, json_extract(value, '$.assetType') FROM json_each(?)
      WHERE json_extract(value, '$.assetType') IN ('equity', 'fund') /* etf-holdings-symbols-insert */`).bind(payload),
  ];
  await env.DB.batch(statements);
  await persistSyncStatus(env, {
    etfTicker,
    syncedAt: now,
    status: isPartial ? "partial" : "ok",
    error: null,
    source: finalResult.source,
    recordsCount: holdings.length,
    sourceUrl: finalResult.sourceUrl,
    sourceTier: finalResult.sourceTier,
    coverage: finalResult.coverage,
    providerRecordsCount: finalResult.providerRecordsCount ?? holdings.length,
    expectedMinRecords: finalResult.expectedMinRecords ?? null,
    lastFullSyncedAt: isPartial ? existing.lastFullSyncedAt : now,
    lastPartialSyncedAt: isPartial ? now : existing.lastPartialSyncedAt,
  });
  return toSyncResult(finalResult);
}
