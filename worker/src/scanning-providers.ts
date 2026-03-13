import type { ScanCandidate, ScanFetchInput, ScanProvider, ScanSourceType } from "./scanning-types";

type CsvRow = Record<string, string>;

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === "\"") {
      if (inQuotes && next === "\"") {
        current += "\"";
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (char === "," && !inQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function parseCsv(raw: string): CsvRow[] {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]).map((header) => header.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row: CsvRow = {};
    headers.forEach((header, idx) => {
      row[header] = (cells[idx] ?? "").trim();
    });
    return row;
  });
}

function safeNumber(value: string | null | undefined): number | null {
  if (!value) return null;
  const normalized = value.replace(/[$,%]/g, "").replace(/,/g, "").trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function pickField(row: CsvRow, names: string[]): string | null {
  for (const name of names) {
    const found = row[name];
    if (typeof found === "string" && found.trim()) return found.trim();
  }
  return null;
}

function normalizeTicker(raw: string | null | undefined): string | null {
  const value = String(raw ?? "").trim().toUpperCase();
  if (!value) return null;
  const stripped = value.includes(":") ? value.split(":").pop() ?? value : value;
  const clean = stripped.replace(/[^A-Z0-9.\-^]/g, "");
  if (!clean || !/^[A-Z0-9.\-^]{1,20}$/.test(clean)) return null;
  return clean;
}

function candidateFromCsvRow(row: CsvRow): ScanCandidate | null {
  const ticker = normalizeTicker(pickField(row, ["ticker", "symbol", "stock", "code"]));
  if (!ticker) return null;
  return {
    ticker,
    displayName: pickField(row, ["name", "description", "company", "display_name"]),
    exchange: pickField(row, ["exchange", "market"]),
    providerRowKey: pickField(row, ["id", "rowid", "provider_row_key"]),
    rankValue: safeNumber(pickField(row, ["rank", "rank_value", "score", "sort_value"])),
    rankLabel: pickField(row, ["rank_label", "score_label", "label"]),
    price: safeNumber(pickField(row, ["price", "last", "close"])),
    change1d: safeNumber(pickField(row, ["change_1d", "change1d", "change", "1d", "perf", "perf%"])),
    volume: safeNumber(pickField(row, ["volume", "vol"])),
    marketCap: safeNumber(pickField(row, ["market_cap", "marketcap", "cap"])),
    raw: row,
  };
}

export class CsvTextProvider implements ScanProvider {
  readonly name = "csv-text";
  readonly priority = 90;

  canHandle(input: ScanFetchInput): boolean {
    return input.sourceType === "csv-text";
  }

  async fetch(input: ScanFetchInput): Promise<ScanCandidate[]> {
    return parseCsv(input.sourceValue)
      .map(candidateFromCsvRow)
      .filter((row): row is ScanCandidate => Boolean(row));
  }
}

export class TickerListProvider implements ScanProvider {
  readonly name = "ticker-list";
  readonly priority = 80;

  canHandle(input: ScanFetchInput): boolean {
    return input.sourceType === "ticker-list";
  }

  async fetch(input: ScanFetchInput): Promise<ScanCandidate[]> {
    return input.sourceValue
      .split(/[\s,\r\n\t]+/)
      .map((token) => normalizeTicker(token))
      .filter((token): token is string => Boolean(token))
      .map((ticker) => ({
        ticker,
        raw: { ticker },
      }));
  }
}

function extractJsonArray(source: string, marker: string): string | null {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) return null;
  const arrayStart = source.indexOf("[", markerIndex + marker.length);
  if (arrayStart < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = arrayStart; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "[") {
      depth += 1;
      continue;
    }
    if (char === "]") {
      depth -= 1;
      if (depth === 0) return source.slice(arrayStart, index + 1);
    }
  }
  return null;
}

function tryExtractTradingViewWatchlistSymbols(html: string): ScanCandidate[] {
  const arrayText = extractJsonArray(html, "\"symbols\":");
  if (!arrayText) return [];

  let values: unknown;
  try {
    values = JSON.parse(arrayText);
  } catch {
    return [];
  }
  if (!Array.isArray(values)) return [];

  const out: ScanCandidate[] = [];
  let currentSection: string | null = null;
  values.forEach((entry, index) => {
    const value = String(entry ?? "").trim();
    if (!value) return;
    if (value.startsWith("###")) {
      currentSection = value.replace(/^#+/, "").trim() || null;
      return;
    }
    const ticker = normalizeTicker(value);
    if (!ticker) return;
    const exchange = value.includes(":") ? value.split(":")[0]?.trim().toUpperCase() ?? null : null;
    out.push({
      ticker,
      exchange,
      providerRowKey: `watchlist:${index}:${value}`,
      rankValue: out.length + 1,
      rankLabel: currentSection,
      raw: {
        source: "tradingview-watchlist-symbols",
        symbol: value,
        section: currentSection,
        position: index,
      },
    });
  });
  return out;
}

function tryExtractTickersFromHtml(html: string): ScanCandidate[] {
  const out: ScanCandidate[] = [];
  const seen = new Set<string>();
  const patterns = [
    /"symbol"\s*:\s*"([^"]+)"/gi,
    /"proName"\s*:\s*"([^"]+)"/gi,
    /"ticker"\s*:\s*"([^"]+)"/gi,
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const ticker = normalizeTicker(match[1]);
      if (!ticker || seen.has(ticker)) continue;
      seen.add(ticker);
      out.push({ ticker, raw: { extracted: match[0] } });
    }
  }
  return out;
}

function extractTickersFromUrl(url: URL): ScanCandidate[] {
  const out: ScanCandidate[] = [];
  const seen = new Set<string>();
  const params = ["symbol", "symbols", "ticker", "tickers"];
  for (const key of params) {
    const value = url.searchParams.get(key);
    if (!value) continue;
    for (const token of value.split(/[,\s|;]+/)) {
      const ticker = normalizeTicker(token);
      if (!ticker || seen.has(ticker)) continue;
      seen.add(ticker);
      out.push({ ticker, raw: { queryParam: key, token } });
    }
  }
  return out;
}

export class TradingViewPublicLinkProvider implements ScanProvider {
  readonly name = "tradingview-public-link";
  readonly priority = 100;

  canHandle(input: ScanFetchInput): boolean {
    if (input.sourceType !== "tradingview-public-link") return false;
    try {
      const url = new URL(input.sourceValue);
      return /tradingview\.com$/i.test(url.hostname) || /tradingview\.com$/i.test(url.hostname.replace(/^www\./i, ""));
    } catch {
      return false;
    }
  }

  async fetch(input: ScanFetchInput): Promise<ScanCandidate[]> {
    const url = new URL(input.sourceValue);
    const fromUrl = extractTickersFromUrl(url);
    if (fromUrl.length > 0) return fromUrl;

    const response = await fetch(url.toString(), {
      headers: {
        "User-Agent": "market-command-centre/1.0",
        Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
      },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`TradingView fetch failed (${response.status}): ${body.slice(0, 160)}`);
    }
    const html = await response.text();
    const fromWatchlist = tryExtractTradingViewWatchlistSymbols(html);
    if (fromWatchlist.length > 0) return fromWatchlist;
    return tryExtractTickersFromHtml(html);
  }
}

export function defaultScanProviders(): ScanProvider[] {
  return [new TradingViewPublicLinkProvider(), new CsvTextProvider(), new TickerListProvider()];
}

export function normalizeScanSourceType(raw: string | null | undefined): ScanSourceType | null {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "tradingview-public-link" || value === "csv-text" || value === "ticker-list") return value;
  return null;
}
