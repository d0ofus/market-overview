import type { InboundEmailPayload, ParsedTradingViewAlert } from "./alerts-types";

const STOPWORDS = new Set([
  "ALERT",
  "ALERTS",
  "TRADINGVIEW",
  "STRATEGY",
  "SIGNAL",
  "BUY",
  "SELL",
  "LONG",
  "SHORT",
  "CROSS",
  "CROSSOVER",
  "CROSSUNDER",
  "PREMARKET",
  "REGULAR",
  "AFTER",
  "HOURS",
  "STOCK",
  "PRICE",
  "USD",
  "NYSE",
  "NASDAQ",
  "AMEX",
  "BINANCE",
  "COINBASE",
  "BYBIT",
  "KRAKEN",
  "BITSTAMP",
]);

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"');
}

function stripHtml(value: string): string {
  return decodeHtml(value.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " "));
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeCandidate(raw: string): string | null {
  const trimmed = raw
    .trim()
    .replace(/^\$/g, "")
    .replace(/^["'([{<]+|["'\])}>.,;:!?]+$/g, "");
  if (!trimmed) return null;
  const withoutExchange = trimmed.includes(":") ? trimmed.split(":").pop() ?? trimmed : trimmed;
  const upper = withoutExchange.toUpperCase();
  if (!/^[A-Z^][A-Z0-9.\-^]{0,19}$/.test(upper)) return null;
  if (STOPWORDS.has(upper)) return null;
  return upper;
}

export function extractTickerSymbol(input: string): string | null {
  const normalized = normalizeWhitespace(input);
  const patterns = [
    /(?:ticker|symbol|instrument|tv symbol|stock)\s*[:=]\s*([$A-Za-z0-9:.\-^]{1,32})/gi,
    /\b([A-Z]{2,12}USDT|[A-Z]{2,12}USD|[A-Z]{2,12}BTC|[A-Z]{2,12}ETH)\b/g,
    /\b(?:NASDAQ|NYSE|NYSEARCA|AMEX|CBOE|OTC|BINANCE|COINBASE):([A-Z0-9.\-^]{1,20})\b/g,
    /\b[A-Z][A-Z0-9._-]{1,15}:([A-Z][A-Z0-9.\-^]{0,19})\b/g,
    /\$([A-Z][A-Z0-9.\-^]{0,19})\b/g,
    /\b([A-Z][A-Z0-9.\-^]{0,19})\b(?=\s+(?:alert|signal|strategy|cross|crossing|breakout|breakdown|buy|sell)\b)/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(normalized)) !== null) {
      const ticker = normalizeCandidate(match[1] ?? match[0] ?? "");
      if (ticker) return ticker;
    }
  }

  const upperWords = normalized.match(/\b[$]?[A-Z][A-Z0-9.\-^]{0,19}\b/g) ?? [];
  for (const word of upperWords) {
    const ticker = normalizeCandidate(word);
    if (ticker) return ticker;
  }
  return null;
}

function parseJsonMetadata(rawText: string): Record<string, string> {
  const payload = rawText.trim();
  if (!payload.startsWith("{") || !payload.endsWith("}")) return {};
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const output: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        output[key.trim().toLowerCase()] = String(value);
      }
    }
    return output;
  } catch {
    return {};
  }
}

function parseLineMetadata(rawText: string): Record<string, string> {
  const output: Record<string, string> = {};
  const lines = rawText.split("\n");
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx <= 0 || idx > 40) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (!key || !value || value.length > 2500) continue;
    output[key] = value;
  }
  return output;
}

function selectFirst(metadata: Record<string, string>, keys: string[]): string | null {
  for (const key of keys) {
    const value = metadata[key];
    if (value && value.trim()) return value.trim();
  }
  return null;
}

function deriveAlertType(subject: string, metadata: Record<string, string>): string | null {
  const fromMeta = selectFirst(metadata, ["alert", "alert type", "action", "signal", "type"]);
  if (fromMeta) return fromMeta.slice(0, 120);
  const upper = subject.toUpperCase();
  if (upper.includes(" BUY ") || upper.startsWith("BUY ")) return "buy";
  if (upper.includes(" SELL ") || upper.startsWith("SELL ")) return "sell";
  if (upper.includes(" LONG ")) return "long";
  if (upper.includes(" SHORT ")) return "short";
  return null;
}

function deriveStrategyName(subject: string, metadata: Record<string, string>): string | null {
  const fromMeta = selectFirst(metadata, ["strategy", "strategy name", "strategy_name"]);
  if (fromMeta) return fromMeta.slice(0, 180);
  const trimmedSubject = subject.trim();
  if (!trimmedSubject) return null;
  const dashParts = trimmedSubject.split(" - ").map((part) => part.trim()).filter(Boolean);
  if (dashParts.length >= 2 && /alert|signal/i.test(dashParts[dashParts.length - 1])) {
    return dashParts[0].slice(0, 180);
  }
  return null;
}

export function parseTradingViewAlertEmail(payload: InboundEmailPayload): ParsedTradingViewAlert | null {
  const subject = normalizeWhitespace(payload.subject ?? "");
  const textBody = normalizeWhitespace(payload.text ?? "");
  const htmlBody = normalizeWhitespace(stripHtml(payload.html ?? ""));
  const combinedBody = normalizeWhitespace([textBody, htmlBody].filter(Boolean).join("\n\n"));
  const fallbackBody = (() => {
    if (!payload.rawPayload) return "";
    try {
      return JSON.stringify(payload.rawPayload);
    } catch {
      return String(payload.rawPayload);
    }
  })();
  const messageBody = normalizeWhitespace(combinedBody || textBody || htmlBody || fallbackBody);
  if (!subject && !messageBody) return null;

  const metadata = {
    ...parseLineMetadata(messageBody),
    ...parseJsonMetadata(messageBody),
  };

  const metadataTicker = normalizeCandidate(selectFirst(metadata, ["ticker", "symbol", "instrument", "tv_symbol", "syminfo.ticker"]) ?? "");
  const ticker = metadataTicker ?? extractTickerSymbol(`${subject}\n${messageBody}`);
  if (!ticker) return null;

  return {
    ticker,
    alertType: deriveAlertType(subject, metadata),
    strategyName: deriveStrategyName(subject, metadata),
    messageBody: messageBody.slice(0, 12000),
    metadata,
  };
}

