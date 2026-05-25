const PREFERRED_SYMBOL_SUFFIX_RE = /(?:\/P[A-Z0-9]*|[.$-]P[A-Z0-9]+)$/i;
const ISSUE_TYPE_RE = /\b(preferred|preference|pfd|warrant|rights?|units?|fund|etfs?|etns?)\b/i;
const PREFERRED_ISSUE_TEXT_RE = [
  /\bdepositary shares?\b/i,
  /\bpreferred stocks?\b/i,
  /\bpreferred shares?\b/i,
  /\bpreference shares?\b/i,
  /\bpfd\b/i,
  /\bcumulative\b/i,
  /\bredeemable\b/i,
  /\bperpetual\b/i,
];
const PREFERRED_WITH_ISSUE_CONTEXT_RE = /\b(series|stock|shares?|depositary|cumulative|redeemable|perpetual|pfd)\b/i;

export const EARNINGS_ALL_MATCHES_LIMIT = 1000;

const UPPER_TICKER_SQL = "UPPER(COALESCE(ticker, ''))";
const UPPER_SOURCE_SYMBOL_SQL = "UPPER(COALESCE(source_symbol, ''))";
const LOWER_COMPANY_NAME_SQL = "LOWER(COALESCE(company_name, ''))";

export const EARNINGS_ELIGIBLE_ISSUE_SQL = `(
  ${UPPER_TICKER_SQL} NOT LIKE '%/P%'
  AND ${UPPER_SOURCE_SYMBOL_SQL} NOT LIKE '%/P%'
  AND ${UPPER_TICKER_SQL} NOT LIKE '%.P%'
  AND ${UPPER_SOURCE_SYMBOL_SQL} NOT LIKE '%.P%'
  AND ${UPPER_TICKER_SQL} NOT LIKE '%-P%'
  AND ${UPPER_SOURCE_SYMBOL_SQL} NOT LIKE '%-P%'
  AND ${UPPER_TICKER_SQL} NOT LIKE '%$P%'
  AND ${UPPER_SOURCE_SYMBOL_SQL} NOT LIKE '%$P%'
  AND NOT (
    ${LOWER_COMPANY_NAME_SQL} LIKE '%depositary share%'
    OR ${LOWER_COMPANY_NAME_SQL} LIKE '%preferred stock%'
    OR ${LOWER_COMPANY_NAME_SQL} LIKE '%preferred share%'
    OR ${LOWER_COMPANY_NAME_SQL} LIKE '%preference share%'
    OR ${LOWER_COMPANY_NAME_SQL} LIKE '% pfd%'
    OR ${LOWER_COMPANY_NAME_SQL} LIKE 'pfd %'
    OR ${LOWER_COMPANY_NAME_SQL} LIKE '%pfd.%'
    OR ${LOWER_COMPANY_NAME_SQL} LIKE '%cumulative%'
    OR ${LOWER_COMPANY_NAME_SQL} LIKE '%redeemable%'
    OR ${LOWER_COMPANY_NAME_SQL} LIKE '%perpetual%'
    OR (
      ${LOWER_COMPANY_NAME_SQL} LIKE '%preferred%'
      AND (
        ${LOWER_COMPANY_NAME_SQL} LIKE '%series%'
        OR ${LOWER_COMPANY_NAME_SQL} LIKE '%stock%'
        OR ${LOWER_COMPANY_NAME_SQL} LIKE '%share%'
        OR ${LOWER_COMPANY_NAME_SQL} LIKE '%depositary%'
      )
    )
  )
)`;

function normalize(value: unknown): string {
  return String(value ?? "").trim();
}

function symbolToken(value: unknown): string {
  const raw = normalize(value).toUpperCase();
  if (!raw) return "";
  const parts = raw.split(":");
  return parts[parts.length - 1] ?? raw;
}

export function hasPreferredShareTickerPattern(value: unknown): boolean {
  const symbol = symbolToken(value);
  return Boolean(symbol && PREFERRED_SYMBOL_SUFFIX_RE.test(symbol));
}

export function hasPreferredIssueText(value: unknown): boolean {
  const text = normalize(value);
  if (!text) return false;
  if (PREFERRED_ISSUE_TEXT_RE.some((pattern) => pattern.test(text))) return true;
  return /\bpreferred\b/i.test(text) && PREFERRED_WITH_ISSUE_CONTEXT_RE.test(text);
}

export function isExcludedEarningsIssue(input: {
  ticker?: unknown;
  sourceSymbol?: unknown;
  companyName?: unknown;
  issueType?: unknown;
}): boolean {
  return hasPreferredShareTickerPattern(input.ticker)
    || hasPreferredShareTickerPattern(input.sourceSymbol)
    || hasPreferredIssueText(input.companyName)
    || ISSUE_TYPE_RE.test(normalize(input.issueType));
}

export function normalizeEarningsQueryLimit(
  value: number | null | undefined,
  defaultLimit: number,
  maxLimit: number,
): number {
  const parsed = Number(value ?? defaultLimit);
  if (parsed === 0) return EARNINGS_ALL_MATCHES_LIMIT;
  if (!Number.isFinite(parsed)) return defaultLimit;
  return Math.max(1, Math.min(maxLimit, Math.floor(parsed)));
}

export function normalizeEarningsQueryOffset(value: number | null | undefined, requestedLimit: number | null | undefined): number {
  return Number(requestedLimit) === 0 ? 0 : Math.max(0, Number(value ?? 0));
}
