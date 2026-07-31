import { SP500_TICKERS } from "./sp500-tickers";

const NASDAQ_TRADER_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqtraded.txt";
const SP500_CSV_URL = "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv";
const ISHARES_ORIGIN = "https://www.ishares.com";
const IWM_PRODUCT_PAGE_URL = `${ISHARES_ORIGIN}/us/products/239710/ishares-russell-2000-etf`;
const IWM_HOLDINGS_CSV_URL = `${IWM_PRODUCT_PAGE_URL}/latest-holdings.csv`;

const SAFE_TICKER_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;
const BANNED_NAME_TERMS = ["warrant", "preferred", "interest", "acquisition", "leveraged"];
const BANNED_NAME_REGEXES = [
  /\bunits?\b/i,
  /\betfs?\b/i,
  /\betns?\b/i,
  /\brights?\b/i,
  /\bnotes?\b/i,
  /\bpar value\b/i,
  /\bfixed-rate\b/i,
  /\bfixed-income\b/i,
];

export type NasdaqTraderCommonStock = {
  symbol: string;
  securityName: string;
  listingExchange: string;
};

function normalizeTicker(raw: string): string {
  return raw.trim().toUpperCase();
}

function dedupeSorted(values: string[]): string[] {
  return Array.from(new Set(values.map(normalizeTicker).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function looksLikeCommonStock(symbol: string, securityName: string, etfFlag: string, testIssueFlag: string): boolean {
  if (!symbol || !securityName) return false;
  if (normalizeTicker(etfFlag) === "Y") return false;
  if (normalizeTicker(testIssueFlag) === "Y") return false;
  if (symbol.includes(".") || symbol.includes("$")) return false;
  if (!SAFE_TICKER_RE.test(symbol)) return false;

  const name = securityName.toLowerCase();
  if (BANNED_NAME_TERMS.some((term) => name.includes(term))) return false;
  if (BANNED_NAME_REGEXES.some((re) => re.test(securityName))) return false;
  return true;
}

function csvSplit(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "\"") {
      const next = line[i + 1];
      if (inQuotes && next === "\"") {
        current += "\"";
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((cell) => cell.trim());
}

async function fetchText(url: string): Promise<string> {
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    Accept: "text/plain,text/html,text/csv;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Source fetch failed (${res.status}) for ${url}`);
  }
  return await res.text();
}

export function parseNasdaqTradedCommonStocks(raw: string): NasdaqTraderCommonStock[] {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const out: NasdaqTraderCommonStock[] = [];

  for (const line of lines) {
    if (line.startsWith("Nasdaq Traded|")) continue;
    if (line.startsWith("File Creation Time")) break;
    const parts = line.split("|");
    if (parts.length < 12) continue;
    const symbol = normalizeTicker(parts[1] ?? "");
    const securityName = (parts[2] ?? "").trim();
    const listingExchange = normalizeTicker(parts[3] ?? "");
    const etfFlag = normalizeTicker(parts[5] ?? "");
    const testIssueFlag = normalizeTicker(parts[7] ?? "");
    if (!looksLikeCommonStock(symbol, securityName, etfFlag, testIssueFlag)) continue;
    out.push({
      symbol,
      securityName,
      listingExchange,
    });
  }

  return out;
}

export function parseNasdaqTradedActiveEquities(raw: string): NasdaqTraderCommonStock[] {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const out: NasdaqTraderCommonStock[] = [];
  for (const line of lines) {
    if (line.startsWith("Nasdaq Traded|") || /^symbol\|/i.test(line)) continue;
    if (line.startsWith("File Creation Time")) break;
    const parts = line.split("|");
    if (parts.length < 12) continue;
    const symbol = normalizeTicker(parts[1] ?? "");
    const securityName = String(parts[2] ?? "").trim();
    const listingExchange = normalizeTicker(parts[3] ?? "");
    const isEtf = normalizeTicker(parts[5] ?? "") === "Y";
    const isTestIssue = normalizeTicker(parts[7] ?? "") === "Y";
    if (!symbol || !securityName || isEtf || isTestIssue || !SAFE_TICKER_RE.test(symbol)) continue;
    out.push({ symbol, securityName, listingExchange });
  }
  return out;
}

export async function loadNasdaqTraderCommonStocks(): Promise<NasdaqTraderCommonStock[]> {
  const raw = await fetchText(NASDAQ_TRADER_URL);
  return parseNasdaqTradedCommonStocks(raw);
}

export function parseSp500Csv(raw: string): string[] {
  return parseTickerCsv(raw, ["Symbol"]);
}

function parseTickerCsv(raw: string, tickerColumnNames: string[]): string[] {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 2) return [];

  const header = csvSplit(lines[0] ?? "");
  const normalizeHeader = (value: string) => value.trim().toLowerCase().replace(/\s+/g, "");
  const targetNames = new Set(tickerColumnNames.map((name) => normalizeHeader(name)));
  let tickerCol = header.findIndex((cell) => targetNames.has(normalizeHeader(cell)));
  if (tickerCol < 0) tickerCol = 0;

  const out: string[] = [];
  for (const line of lines.slice(1)) {
    const cells = csvSplit(line);
    const ticker = normalizeTicker(cells[tickerCol] ?? "");
    if (!ticker || !SAFE_TICKER_RE.test(ticker)) continue;
    out.push(ticker);
  }
  return dedupeSorted(out);
}


export async function loadNasdaqTraderUniverses(): Promise<{
  nasdaqTickers: string[];
  nyseTickers: string[];
  allCommonTickers: string[];
  allActiveEquityTickers: string[];
}> {
  const raw = await fetchText(NASDAQ_TRADER_URL);
  const rows = parseNasdaqTradedCommonStocks(raw);
  const activeRows = parseNasdaqTradedActiveEquities(raw);
  const nasdaqTickers = dedupeSorted(rows.filter((r) => r.listingExchange === "Q").map((r) => r.symbol));
  const nyseTickers = dedupeSorted(rows.filter((r) => r.listingExchange === "N").map((r) => r.symbol));
  const allCommonTickers = dedupeSorted(rows.map((r) => r.symbol));
  const allActiveEquityTickers = dedupeSorted(activeRows.map((r) => r.symbol));
  return { nasdaqTickers, nyseTickers, allCommonTickers, allActiveEquityTickers };
}

export function parseIsharesHoldingsCsv(raw: string): string[] {
  return parseIsharesHoldingsCsvDetailed(raw).tickers;
}

export type IsharesHolding = {
  sourceTicker: string;
  issuerName: string | null;
  exchange: string | null;
  assetClass: string;
};

export type IsharesHoldingsParseResult = {
  sourceAsOfDate: string | null;
  sourceEquityCount: number;
  duplicateTickerCount: number;
  blankTickerCount: number;
  excludedCount: number;
  tickers: string[];
  holdings: IsharesHolding[];
  invalidSourceIdentifiers: string[];
  duplicateSourceIdentifiers: string[];
  excludedSourceIdentifiers: string[];
};

function parseIsharesAsOfDate(lines: string[]): string | null {
  const months: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  };
  for (const line of lines.slice(0, 20)) {
    if (!/fund holdings as of/i.test(line)) continue;
    const match = line.match(/([A-Za-z]{3})\s+(\d{1,2}),?\s*,?\s*(\d{4})/);
    if (!match) continue;
    const month = months[(match[1] ?? "").toLowerCase()];
    if (!month) continue;
    return `${match[3]}-${String(month).padStart(2, "0")}-${String(Number(match[2])).padStart(2, "0")}`;
  }
  return null;
}

function parseCsvNumber(raw: string): number | null {
  const normalized = raw.replace(/,/g, "").trim();
  if (!normalized || normalized === "-") return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

export function parseIsharesHoldingsCsvDetailed(raw: string): IsharesHoldingsParseResult {
  const lines = raw.split(String.fromCharCode(10)).map((line) =>
    line.endsWith(String.fromCharCode(13)) ? line.slice(0, -1) : line,
  );
  const headerIndex = lines.findIndex((line) => {
    const normalized = csvSplit(line).map((cell) => cell.toLowerCase());
    return normalized.includes("ticker") && normalized.includes("asset class");
  });
  if (headerIndex < 0) return { sourceAsOfDate: null, sourceEquityCount: 0, duplicateTickerCount: 0, blankTickerCount: 0, excludedCount: 0, tickers: [], holdings: [], invalidSourceIdentifiers: [], duplicateSourceIdentifiers: [], excludedSourceIdentifiers: [] };
  const header = csvSplit(lines[headerIndex] ?? "").map((cell) => cell.trim().toLowerCase());
  const tickerIndex = header.indexOf("ticker");
  const assetClassIndex = header.indexOf("asset class");
  if (tickerIndex < 0 || assetClassIndex < 0) {
    return { sourceAsOfDate: parseIsharesAsOfDate(lines), sourceEquityCount: 0, duplicateTickerCount: 0, blankTickerCount: 0, excludedCount: 0, tickers: [], holdings: [], invalidSourceIdentifiers: [], duplicateSourceIdentifiers: [], excludedSourceIdentifiers: [] };
  }
  const nameIndex = header.indexOf("name");
  const exchangeIndex = header.indexOf("exchange");
  const priceIndex = header.indexOf("price");
  const seenRawTickers = new Set<string>();
  let sourceEquityCount = 0;
  let duplicateTickerCount = 0;
  let blankTickerCount = 0;
  const invalidSourceIdentifiers: string[] = [];
  const duplicateSourceIdentifiers: string[] = [];
  const excludedSourceIdentifiers: string[] = [];
  const holdingsByTicker = new Map<string, IsharesHolding>();
  for (const [rowOffset, line] of lines.slice(headerIndex + 1).entries()) {
    const cells = csvSplit(line);
    if ((cells[assetClassIndex] ?? "").trim().toLowerCase() !== "equity") continue;
    const rawTicker = (cells[tickerIndex] ?? "").trim().toUpperCase();
    sourceEquityCount += 1;
    if (!rawTicker) {
      blankTickerCount += 1;
    } else if (seenRawTickers.has(rawTicker)) {
      duplicateTickerCount += 1;
      duplicateSourceIdentifiers.push(rawTicker);
    }
    if (rawTicker) seenRawTickers.add(rawTicker);
    const ticker = normalizeTicker(rawTicker);
    const sourceKey = rawTicker || `(blank row ${headerIndex + rowOffset + 2})`;
    if (!ticker || !SAFE_TICKER_RE.test(ticker)) {
      invalidSourceIdentifiers.push(sourceKey);
      continue;
    }
    const name = (cells[nameIndex] ?? "").trim();
    const exchange = (cells[exchangeIndex] ?? "").trim().toLowerCase();
    const price = priceIndex >= 0 ? parseCsvNumber(cells[priceIndex] ?? "") : null;
    const nonMarket = exchange.includes("no market") || exchange.includes("non-nms") || exchange.includes("unlisted");
    const residual = /\b(?:cvr|escrow)\b/i.test(name) || (priceIndex >= 0 && (price == null || price <= 0));
    if (nonMarket || residual) {
      excludedSourceIdentifiers.push(`${nonMarket ? "non-market" : "residual"}:${rawTicker}`);
      continue;
    }
    if (!holdingsByTicker.has(ticker)) {
      holdingsByTicker.set(ticker, {
        sourceTicker: ticker,
        issuerName: name || null,
        exchange: (cells[exchangeIndex] ?? "").trim() || null,
        assetClass: "Equity",
      });
    }
  }
  const holdings = Array.from(holdingsByTicker.values()).sort((a, b) => a.sourceTicker.localeCompare(b.sourceTicker));
  const resolvedTickers = holdings.map((holding) => holding.sourceTicker);
  return {
    sourceAsOfDate: parseIsharesAsOfDate(lines),
    sourceEquityCount,
    duplicateTickerCount,
    blankTickerCount,
    excludedCount: sourceEquityCount - resolvedTickers.length,
    tickers: resolvedTickers,
    holdings,
    invalidSourceIdentifiers: Array.from(new Set(invalidSourceIdentifiers)).sort(),
    duplicateSourceIdentifiers: Array.from(new Set(duplicateSourceIdentifiers)).sort(),
    excludedSourceIdentifiers: Array.from(new Set(excludedSourceIdentifiers)).sort(),
  };
}

export function extractIsharesHoldingsCsvUrl(productPageHtml: string): string | null {
  const hrefPattern = /href\s*=\s*["']([^"']+\.csv(?:\?[^"']*)?)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefPattern.exec(productPageHtml)) !== null) {
    try {
      const url = new URL(match[1] ?? "", ISHARES_ORIGIN);
      if (url.origin !== ISHARES_ORIGIN) continue;
      if (!url.pathname.startsWith("/us/products/239710/")) continue;
      if (!/holdings/i.test(url.pathname)) continue;
      return url.toString();
    } catch {
      continue;
    }
  }
  return null;
}

export async function loadSp500Constituents(allCommonUniverse?: Set<string>): Promise<string[]> {
  try {
    const raw = await fetchText(SP500_CSV_URL);
    const parsed = parseSp500Csv(raw);
    if (parsed.length >= 450) {
      if (!allCommonUniverse || allCommonUniverse.size === 0) return parsed;
      const intersected = parsed.filter((ticker) => allCommonUniverse.has(ticker));
      if (intersected.length >= parsed.length - 5) return intersected;
      return parsed;
    }
  } catch (error) {
    console.error("sp500 constituent source fetch failed; using bundled fallback", error);
  }
  return dedupeSorted(SP500_TICKERS);
}

export type Russell2000UniverseLoad = {
  tickers: string[];
  sourceAsOfDate: string | null;
  sourceMemberCount: number;
  normalizedMemberCount: number;
  unresolvedCount: number;
  unresolvedTickers: string[];
  sourceType: "official-etf-holdings-proxy";
  sourceUrl: string;
  memberMetadata: Record<string, IsharesHolding>;
};

export async function loadRussell2000Universe(allCommonUniverse?: Set<string>): Promise<Russell2000UniverseLoad> {
  let csvRaw: string;
  let sourceUrl = IWM_HOLDINGS_CSV_URL;
  try {
    csvRaw = await fetchText(sourceUrl);
  } catch (primaryError) {
    const productPage = await fetchText(IWM_PRODUCT_PAGE_URL);
    const discoveredUrl = extractIsharesHoldingsCsvUrl(productPage);
    if (!discoveredUrl) throw primaryError;
    sourceUrl = discoveredUrl;
    csvRaw = await fetchText(sourceUrl);
  }
  const parsed = parseIsharesHoldingsCsvDetailed(csvRaw);
  if (!parsed.sourceAsOfDate) {
    throw new Error("IWM holdings source date is missing or unparseable");
  }
  if (parsed.blankTickerCount > 0 || parsed.duplicateTickerCount > 10) {
    throw new Error(
      `IWM holdings contains invalid source rows (blank tickers: ${parsed.blankTickerCount}, duplicate tickers: ${parsed.duplicateTickerCount}; maximum duplicates: 10)`,
    );
  }
  let tickers = parsed.tickers;
  let unresolvedTickers: string[] = [
    ...parsed.invalidSourceIdentifiers,
    ...parsed.duplicateSourceIdentifiers.map((ticker) => `duplicate:${ticker}`),
    ...parsed.excludedSourceIdentifiers,
  ];
  const sourceToProvider = new Map(parsed.tickers.map((ticker) => [ticker, ticker]));
  if (allCommonUniverse && allCommonUniverse.size > 0) {
    const normalizedCandidates = new Map<string, string[]>();
    for (const candidate of allCommonUniverse) {
      const key = candidate.replace(/[^A-Z0-9]/g, "");
      const matches = normalizedCandidates.get(key) ?? [];
      matches.push(candidate);
      normalizedCandidates.set(key, matches);
    }
    const resolved: string[] = [];
    sourceToProvider.clear();
    for (const sourceTicker of tickers) {
      if (allCommonUniverse.has(sourceTicker)) {
        resolved.push(sourceTicker);
        sourceToProvider.set(sourceTicker, sourceTicker);
        continue;
      }
      const aliases = normalizedCandidates.get(sourceTicker.replace(/[^A-Z0-9]/g, "")) ?? [];
      if (aliases.length === 1) {
        resolved.push(aliases[0]!);
        sourceToProvider.set(sourceTicker, aliases[0]!);
      } else {
        unresolvedTickers.push(sourceTicker);
      }
    }
    const coveragePct = parsed.tickers.length > 0 ? (resolved.length / parsed.tickers.length) * 100 : 0;
    if (coveragePct < 95) {
      throw new Error(`IWM symbol resolution coverage ${coveragePct.toFixed(2)}% is below 95%`);
    }
    tickers = resolved;
  }
  const memberMetadata = Object.fromEntries(parsed.holdings.flatMap((holding) => {
    const providerTicker = sourceToProvider.get(holding.sourceTicker);
    return providerTicker ? [[providerTicker, holding] as const] : [];
  }));
  return {
    tickers: dedupeSorted(tickers),
    sourceAsOfDate: parsed.sourceAsOfDate,
    sourceMemberCount: parsed.sourceEquityCount,
    normalizedMemberCount: parsed.tickers.length,
    unresolvedCount: Math.max(0, parsed.sourceEquityCount - dedupeSorted(tickers).length),
    unresolvedTickers,
    sourceType: "official-etf-holdings-proxy",
    sourceUrl,
    memberMetadata,
  };
}

export async function loadRussell2000Constituents(allCommonUniverse?: Set<string>): Promise<string[]> {
  return (await loadRussell2000Universe(allCommonUniverse)).tickers;
}
