export type PerplexityFinanceLookupStatus =
  | "ready"
  | "partial"
  | "pending_timeout"
  | "blocked"
  | "not_found"
  | "parse_error";

export type PerplexityFinanceBodyState = "ready" | "pending" | "blocked" | "not_found" | "empty" | "unknown";

export type PerplexityFinanceCompany = {
  name: string | null;
  exchange: string | null;
  sector: string | null;
  industry: string | null;
  description: string | null;
};

export type PerplexityFinancePeer = {
  ticker: string;
  name: string | null;
  exchange: string | null;
  rawText: string;
};

export type PerplexityNotablePriceMovementParseResult = {
  notablePriceMovement: string | null;
  matchedSelector: string | null;
  observedHeadings: string[];
};

const TICKER_PATTERN = /^[A-Z0-9]{1,8}(?:[.-][A-Z0-9]{1,5})?$/;
const SECURITY_PATTERN = /Performing security verification|security service to protect|Checking your browser|Just a moment|Enable JavaScript and cookies/i;
const NOT_FOUND_PATTERN = /404 Page Not Found|Quote not found|Profile not found|No finance page found/i;
const PENDING_PATTERN = /Analy[sz]ing list|Analy[sz]ing\.\.\.|Loading\.\.\./i;
const BAD_PEER_CONTEXT_PATTERN = /Create Watchlist|Equity Sectors|Popular Cryptocurrencies|Fixed Income|Financial information provided by/i;
const PRICE_OR_PERCENT_PATTERN = /(?:[$€£¥₹A-Z]{0,4}\s?\d[\d,.]*|\d+(?:\.\d+)?%)/;
const MARKET_COMMENTARY_PATTERN = /\b(rose|fell|rallied|declined|shares|stock|price target|after-hours|at close|closed|outperforming|underperforming|session|trading)\b/i;
const NOTABLE_MOVEMENT_HEADING_PATTERN = /^(?:notable\s+)?price\s+movement$|^notable\s+movement$/i;
const NOTABLE_MOVEMENT_INLINE_HEADING_PATTERN = /^(?:(?:notable\s+)?price\s+movement|notable\s+movement)\s*:?\s+/i;
const NOTABLE_MOVEMENT_STOP_PATTERN =
  /^(?:sources?|citations?|references?|company profile|profile|about|key stats|statistics|financials?|peers?|similar stocks|related stocks|latest news|news|earnings|analyst ratings|forecast|overview|events|historical data|dividends?|sec filings?|financial information provided by)$/i;
const NOTABLE_MOVEMENT_NOISE_PATTERN =
  /^(?:follow|share|search|sign in|log in|create watchlist|add to watchlist|compare|copied|open|expand|show more|read more|ask follow-up)$/i;

export function cleanText(value: unknown): string {
  return String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

export function cleanLine(value: unknown): string {
  return String(value ?? "").replace(/\u00a0/g, " ").trim();
}

export function emptyCompany(): PerplexityFinanceCompany {
  return {
    name: null,
    exchange: null,
    sector: null,
    industry: null,
    description: null,
  };
}

export function normalizeTicker(value: unknown): string | null {
  const ticker = cleanText(value).toUpperCase();
  return TICKER_PATTERN.test(ticker) ? ticker : null;
}

export function isSecurityVerificationText(text: string): boolean {
  return SECURITY_PATTERN.test(text);
}

export function analyzePerplexityBodyText(text: string): PerplexityFinanceBodyState {
  const clean = cleanText(text);
  if (!clean) return "empty";
  if (SECURITY_PATTERN.test(clean)) return "blocked";
  if (NOT_FOUND_PATTERN.test(clean)) return "not_found";
  if (PENDING_PATTERN.test(clean)) return "pending";
  return "ready";
}

export function parseJsonPayload(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isNotableMovementHeading(line: string): boolean {
  return NOTABLE_MOVEMENT_HEADING_PATTERN.test(cleanText(line));
}

function notableMovementInlineRemainder(line: string): string | null {
  const clean = cleanText(line);
  if (!NOTABLE_MOVEMENT_INLINE_HEADING_PATTERN.test(clean)) return null;
  const remainder = clean.replace(NOTABLE_MOVEMENT_INLINE_HEADING_PATTERN, "").trim();
  return remainder.length > 0 ? remainder : null;
}

function isSourceOrCitationLine(line: string): boolean {
  const clean = cleanText(line);
  return (
    NOTABLE_MOVEMENT_STOP_PATTERN.test(clean)
    || /^\d+\s+sources?$/i.test(clean)
    || /^source:/i.test(clean)
    || /^\[\d+\]/.test(clean)
    || /^financial information provided by/i.test(clean)
  );
}

function isObservedHeadingLine(line: string): boolean {
  const clean = cleanText(line);
  if (!clean || clean.length > 90) return false;
  if (isNotableMovementHeading(clean) || NOTABLE_MOVEMENT_STOP_PATTERN.test(clean)) return true;
  if (!/[A-Za-z]/.test(clean) || /[.!?]$/.test(clean)) return false;
  if (PRICE_OR_PERCENT_PATTERN.test(clean) && clean.split(/\s+/).length > 3) return false;
  return /^[A-Z0-9][A-Za-z0-9&/(),.' -]+$/.test(clean) && /[A-Z]/.test(clean.slice(1));
}

function isNotableMovementBoundary(line: string): boolean {
  const clean = cleanText(line);
  if (!clean) return true;
  if (isSourceOrCitationLine(clean) || NOTABLE_MOVEMENT_NOISE_PATTERN.test(clean)) return true;
  return isObservedHeadingLine(clean) && !MARKET_COMMENTARY_PATTERN.test(clean);
}

export function parseNotablePriceMovementFromText(bodyText: string): PerplexityNotablePriceMovementParseResult {
  const lines = bodyText.split(/\n+/).map(cleanLine).filter(Boolean);
  const observedHeadings = Array.from(new Set(lines.filter(isObservedHeadingLine).map(cleanText))).slice(0, 40);
  let headingIndex = -1;
  let inlineRemainder: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = cleanText(lines[index]);
    if (isNotableMovementHeading(line)) {
      headingIndex = index;
      break;
    }
    const remainder = notableMovementInlineRemainder(line);
    if (remainder) {
      headingIndex = index;
      inlineRemainder = remainder;
      break;
    }
  }

  if (headingIndex < 0) {
    return {
      notablePriceMovement: null,
      matchedSelector: null,
      observedHeadings,
    };
  }

  const paragraphParts: string[] = [];
  if (inlineRemainder && !isNotableMovementBoundary(inlineRemainder)) {
    paragraphParts.push(inlineRemainder);
  }

  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const line = cleanText(lines[index]);
    if (!line || isNotableMovementHeading(line) || NOTABLE_MOVEMENT_NOISE_PATTERN.test(line)) continue;
    if (isNotableMovementBoundary(line)) break;
    paragraphParts.push(line);
    if (cleanText(paragraphParts.join(" ")).length > 3_000) break;
  }

  const notablePriceMovement = cleanText(paragraphParts.join(" "));
  return {
    notablePriceMovement: notablePriceMovement || null,
    matchedSelector: inlineRemainder ? "text:inline-notable-price-movement" : `text:${cleanText(lines[headingIndex])}`,
    observedHeadings,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  const text = cleanText(value);
  return text ? text : null;
}

function numberValue(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeTickerToken(value: unknown): string | null {
  const raw = cleanText(value);
  if (!raw || (raw !== raw.toUpperCase() && !/[.-]/.test(raw))) return null;
  return normalizeTicker(raw);
}

export function parseProfileDescriptionPayload(payload: unknown): string | null {
  if (typeof payload === "string") return stringValue(payload);
  if (isRecord(payload)) {
    return stringValue(payload.description) ?? stringValue(payload.summary) ?? stringValue(payload.text);
  }
  return null;
}

export function parseProfilePayload(payload: unknown): PerplexityFinanceCompany {
  if (!isRecord(payload)) return emptyCompany();
  return {
    name: stringValue(payload.companyName) ?? stringValue(payload.name),
    exchange: stringValue(payload.exchange) ?? stringValue(payload.exchangeName) ?? stringValue(payload.exchangeShortName),
    sector: stringValue(payload.sector),
    industry: stringValue(payload.industry),
    description: stringValue(payload.description),
  };
}

export function mergeCompany(...candidates: Array<Partial<PerplexityFinanceCompany> | null | undefined>): PerplexityFinanceCompany {
  const merged = emptyCompany();
  for (const candidate of candidates) {
    if (!candidate) continue;
    merged.name ??= candidate.name ?? null;
    merged.exchange ??= candidate.exchange ?? null;
    merged.sector ??= candidate.sector ?? null;
    merged.industry ??= candidate.industry ?? null;
    merged.description ??= candidate.description ?? null;
  }
  return merged;
}

function formatPeerRawText(row: Record<string, unknown>, ticker: string, name: string | null, exchange: string | null): string {
  const price = numberValue(row.price);
  const change = numberValue(row.changesPercentage ?? row.priceChange24h);
  return [
    name,
    ticker,
    exchange,
    price == null ? null : String(price),
    change == null ? null : `${change}%`,
  ].filter(Boolean).join(" ");
}

function peerArrayFromPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  for (const key of ["peers", "data", "items", "results", "rows", "quotes"]) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

export function parsePeersPresetPayload(payload: unknown, rootTicker: string): PerplexityFinancePeer[] {
  const peerRows = peerArrayFromPayload(payload);
  if (peerRows.length === 0) return [];
  const root = normalizeTicker(rootTicker);
  const found = new Map<string, PerplexityFinancePeer>();
  for (const row of peerRows) {
    if (!isRecord(row)) continue;
    const ticker = normalizeTicker(row.symbol ?? row.ticker ?? row.market_identifier);
    if (!ticker || ticker === root) continue;
    const name = stringValue(row.name) ?? stringValue(row.companyName);
    const exchange = stringValue(row.exchange) ?? stringValue(row.exchangeName) ?? stringValue(row.exchangeShortName);
    found.set(ticker, {
      ticker,
      name,
      exchange,
      rawText: formatPeerRawText(row, ticker, name, exchange),
    });
  }
  return Array.from(found.values()).slice(0, 50);
}

function stripLeadingAvatar(value: string): string {
  const pieces = value.split(/\s+/);
  if (pieces.length > 1 && /^[A-Z]$/.test(pieces[0] ?? "")) return pieces.slice(1).join(" ");
  return value;
}

function isLikelyNameLine(line: string): boolean {
  if (!line || line.length < 3 || line.length > 120) return false;
  if (/^\$|^\d|%$/.test(line)) return false;
  if (TICKER_PATTERN.test(line.toUpperCase())) return false;
  if (/Price|Market Cap|Follow|Compare|Share|Search|Sources?|Updated/i.test(line)) return false;
  if (BAD_PEER_CONTEXT_PATTERN.test(line)) return false;
  return true;
}

function addPeer(found: Map<string, PerplexityFinancePeer>, rootTicker: string, ticker: string, name: string | null, rawText: string) {
  const normalized = normalizeTicker(ticker);
  const root = normalizeTicker(rootTicker);
  if (!normalized || normalized === root || BAD_PEER_CONTEXT_PATTERN.test(rawText)) return;
  if (found.has(normalized)) return;
  found.set(normalized, {
    ticker: normalized,
    name: name ? stripLeadingAvatar(cleanText(name)) : null,
    exchange: null,
    rawText: cleanText(rawText) || normalized,
  });
}

export function parsePeersFromText(bodyText: string, rootTicker: string): PerplexityFinancePeer[] {
  const lines = bodyText.split(/\n+/).map(cleanLine).filter(Boolean);
  const found = new Map<string, PerplexityFinancePeer>();

  for (const line of lines) {
    const compact = cleanText(line);
    if (compact.length < 6 || BAD_PEER_CONTEXT_PATTERN.test(compact)) continue;
    const tokens = compact.split(/\s+/);
    for (let index = 0; index < tokens.length; index += 1) {
      const ticker = normalizeTickerToken(tokens[index]);
      if (!ticker || ticker === normalizeTicker(rootTicker)) continue;
      const suffix = tokens.slice(index + 1).join(" ");
      if (!PRICE_OR_PERCENT_PATTERN.test(suffix)) continue;
      const name = stripLeadingAvatar(tokens.slice(0, index).join(" "));
      if (!isLikelyNameLine(name)) continue;
      addPeer(found, rootTicker, ticker, name, compact);
      break;
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const ticker = normalizeTickerToken(lines[index]);
    if (!ticker || ticker === normalizeTicker(rootTicker)) continue;
    const windowText = lines.slice(Math.max(0, index - 3), index + 7).join(" ");
    if (!PRICE_OR_PERCENT_PATTERN.test(windowText) || BAD_PEER_CONTEXT_PATTERN.test(windowText)) continue;
    const previousName = [...lines.slice(Math.max(0, index - 4), index)]
      .reverse()
      .find(isLikelyNameLine) ?? null;
    addPeer(found, rootTicker, ticker, previousName, windowText);
  }

  return Array.from(found.values()).slice(0, 50);
}

function valueAfterLine(lines: string[], label: string): string | null {
  const index = lines.findIndex((line) => line.toLowerCase() === label.toLowerCase());
  return index >= 0 ? stringValue(lines[index + 1]) : null;
}

function findProfileName(lines: string[], ticker: string): string | null {
  const root = normalizeTicker(ticker);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || line.toUpperCase() === root) continue;
    if (TICKER_PATTERN.test(line.toUpperCase())) continue;
    const nearby = lines.slice(index + 1, index + 5).map((value) => value.toUpperCase());
    if (root && nearby.includes(root) && line.length <= 120) return line;
  }
  return null;
}

function findDescriptionLine(lines: string[], name: string | null, ticker: string): string | null {
  const root = normalizeTicker(ticker);
  const candidates = lines
    .filter((line) => line.length >= 140 && line.length <= 2_800)
    .filter((line) => !MARKET_COMMENTARY_PATTERN.test(line))
    .filter((line) => !/Notable Price Movement|sources?|Prev Close|Market Cap|After-hours|At close/i.test(line))
    .map((line) => {
      let score = 0;
      const lower = line.toLowerCase();
      if (name && lower.includes(name.toLowerCase())) score += 6;
      if (root && line.toUpperCase().includes(` ${root}`)) score += 3;
      if (/\((NASDAQ|NYSE|AMEX|OTC|LSE|ASX|TSX):\s?[A-Z0-9.-]+\)/i.test(line)) score += 5;
      if (/\b(is an?|is a|provides|develops|manufactures|operates|offers)\b/i.test(line)) score += 3;
      return { line, score };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || right.line.length - left.line.length);
  return candidates[0]?.line ?? null;
}

export function parseCompanyFromText(bodyText: string, ticker: string): PerplexityFinanceCompany {
  const lines = bodyText.split(/\n+/).map(cleanLine).filter(Boolean);
  const name = findProfileName(lines, ticker);
  return {
    name,
    exchange: valueAfterLine(lines, "Exchange"),
    sector: valueAfterLine(lines, "Sector"),
    industry: valueAfterLine(lines, "Industry"),
    description: findDescriptionLine(lines, name, ticker),
  };
}
