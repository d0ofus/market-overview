import { SP500_TICKERS } from "./sp500-tickers";

const NASDAQ_TRADER_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqtraded.txt";
const SP500_CSV_URL = "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv";
const IWM_HOLDINGS_CSV_URL =
  "https://www.ishares.com/us/products/239710/1467271812596.ajax?fileType=csv&fileName=IWM_holdings&dataType=fund";
const LSEG_CONSTITUENT_TABLE_URL =
  "https://www.lseg.com/content/dam/ftse-russell/en_us/documents/index-spotlights/data_table.constituentsandweights.json";

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
  if (url.includes("lseg.com")) {
    headers.Referer = "https://www.lseg.com/";
  }
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

export function extractLsegConstituentFileUrl(rawJson: string, indexNamePattern: RegExp): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson) as unknown;
  } catch {
    return null;
  }

  const data = (parsed as { data?: Array<Record<string, unknown>> })?.data ?? [];
  for (const row of data) {
    const indexName = String(row.Index_Name ?? "").trim();
    if (!indexNamePattern.test(indexName)) continue;
    const url = String(row.Constituent_file_url ?? "").trim();
    if (!url) continue;
    if (url.startsWith("http://") || url.startsWith("https://")) return url;
    if (url.startsWith("/")) return `https://www.lseg.com${url}`;
    return `https://www.lseg.com/${url}`;
  }

  return null;
}

export async function loadNasdaqTraderUniverses(): Promise<{
  nasdaqTickers: string[];
  nyseTickers: string[];
  allCommonTickers: string[];
}> {
  const rows = await loadNasdaqTraderCommonStocks();
  const nasdaqTickers = dedupeSorted(rows.filter((r) => r.listingExchange === "Q").map((r) => r.symbol));
  const nyseTickers = dedupeSorted(rows.filter((r) => r.listingExchange === "N").map((r) => r.symbol));
  const allCommonTickers = dedupeSorted(rows.map((r) => r.symbol));
  return { nasdaqTickers, nyseTickers, allCommonTickers };
}

export function parseIsharesHoldingsCsv(raw: string): string[] {
  const lines = raw.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => {
    const normalized = csvSplit(line).map((cell) => cell.toLowerCase());
    return normalized.includes("ticker") && normalized.includes("asset class");
  });
  if (headerIndex < 0) return [];
  const header = csvSplit(lines[headerIndex] ?? "").map((cell) => cell.trim().toLowerCase());
  const tickerIndex = header.indexOf("ticker");
  const assetClassIndex = header.indexOf("asset class");
  if (tickerIndex < 0 || assetClassIndex < 0) return [];
  const tickers: string[] = [];
  for (const line of lines.slice(headerIndex + 1)) {
    const cells = csvSplit(line);
    if ((cells[assetClassIndex] ?? "").trim().toLowerCase() !== "equity") continue;
    const ticker = normalizeTicker(cells[tickerIndex] ?? "");
    if (!ticker || !SAFE_TICKER_RE.test(ticker)) continue;
    tickers.push(ticker);
  }
  return dedupeSorted(tickers);
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

export async function loadRussell2000Constituents(allCommonUniverse?: Set<string>): Promise<string[]> {
  const csvRaw = await fetchText(IWM_HOLDINGS_CSV_URL);
  let tickers = parseIsharesHoldingsCsv(csvRaw);
  if (allCommonUniverse && allCommonUniverse.size > 0) {
    const filtered = tickers.filter((ticker) => allCommonUniverse.has(ticker));
    // Keep the raw scrape if the intersection loses too many symbols due naming mismatches.
    tickers = filtered.length >= tickers.length * 0.95 ? filtered : tickers;
  }
  if (tickers.length < 1800 || tickers.length > 2100) {
    throw new Error(`IWM holdings proxy returned an invalid member count (${tickers.length})`);
  }
  return tickers;
}
