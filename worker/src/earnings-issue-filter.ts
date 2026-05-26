import type { Env } from "./types";

const PREFERRED_SYMBOL_SUFFIX_RE = /(?:\/P[A-Z0-9]*|[.$-]P[A-Z0-9]+)$/i;
const EXCLUDED_ISSUE_TYPE_RE = /\b(preferred|preference|pfd|warrants?|rights?|units?|funds?|etfs?|etns?|bonds?|debt|notes?|debentures?)\b/i;
const PREFERRED_ISSUE_TEXT_RE = [
  /\bpreferred stocks?\b/i,
  /\bpreferred shares?\b/i,
  /\bpreference shares?\b/i,
  /\bpfd\b/i,
  /\bcumulative\b/i,
  /\bredeemable\b/i,
  /\bperpetual\b/i,
];
const PREFERRED_DEPOSITARY_TEXT_RE = /\bdepositary shares?\b/i;
const PREFERRED_WITH_ISSUE_CONTEXT_RE = /\b(series|stock|shares?|depositary|cumulative|redeemable|perpetual|pfd)\b/i;
const DEBT_ISSUE_TEXT_RE = /\b(bonds?|notes?|senior\s+notes?|subordinated\s+notes?|debentures?|baby\s+bonds?|fixed[-\s]?rate|fixed[-\s]?income)\b|\bdue\s+20\d{2}\b/i;
const FUND_UNIT_RIGHT_TEXT_RE = /\b(warrants?|rights?|units?|funds?|etfs?|etns?)\b/i;

const COMMON_EQUITY_ASSET_CLASSES = new Set(["equity", "stock", "stocks", "common_stock", "common stock"]);
const MAJOR_US_EXCHANGES = new Set(["NASDAQ", "NYSE", "AMEX"]);

export const EARNINGS_ALL_MATCHES_LIMIT = 1000;

function sqlColumn(tableName: string | null | undefined, columnName: string): string {
  return tableName ? `${tableName}.${columnName}` : columnName;
}

function sqlUpper(tableName: string | null | undefined, columnName: string): string {
  return `UPPER(COALESCE(${sqlColumn(tableName, columnName)}, ''))`;
}

function sqlLower(tableName: string | null | undefined, columnName: string): string {
  return `LOWER(COALESCE(${sqlColumn(tableName, columnName)}, ''))`;
}

export function earningsMajorUsExchangeSql(tableName?: string | null): string {
  const exchangeSql = tableName ? sqlUpper(tableName, "exchange") : "UPPER(exchange)";
  return `${exchangeSql} IN ('NASDAQ', 'NYSE', 'AMEX')`;
}

function earningsCatalogEligibilitySql(tableName: string): string {
  const tickerSql = sqlUpper(tableName, "ticker");
  return `(
    NOT EXISTS (
      SELECT 1
      FROM symbols catalog_probe
      WHERE COALESCE(catalog_probe.catalog_managed, 0) = 1
        AND COALESCE(catalog_probe.is_active, 1) = 1
      LIMIT 1
    )
    OR EXISTS (
      SELECT 1
      FROM symbols catalog_symbol
      WHERE UPPER(catalog_symbol.ticker) = ${tickerSql}
        AND COALESCE(catalog_symbol.is_active, 1) = 1
        AND LOWER(COALESCE(catalog_symbol.asset_class, 'equity')) IN ('equity', 'stock', 'stocks', 'common_stock', 'common stock')
        AND (
          COALESCE(catalog_symbol.catalog_managed, 0) = 1
          OR COALESCE(catalog_symbol.listing_source, '') = 'manual'
        )
      LIMIT 1
    )
  )`;
}

export function earningsEligibleSecuritySql(
  tableName?: string | null,
  options: { includeCatalog?: boolean } = {},
): string {
  const upperTickerSql = sqlUpper(tableName, "ticker");
  const upperSourceSymbolSql = sqlUpper(tableName, "source_symbol");
  const lowerCompanyNameSql = sqlLower(tableName, "company_name");
  const clauses = [
    `${upperTickerSql} NOT LIKE '%/P%'`,
    `${upperSourceSymbolSql} NOT LIKE '%/P%'`,
    `${upperTickerSql} NOT LIKE '%.P%'`,
    `${upperSourceSymbolSql} NOT LIKE '%.P%'`,
    `${upperTickerSql} NOT LIKE '%-P%'`,
    `${upperSourceSymbolSql} NOT LIKE '%-P%'`,
    `${upperTickerSql} NOT LIKE '%$P%'`,
    `${upperSourceSymbolSql} NOT LIKE '%$P%'`,
    `NOT (
      ${lowerCompanyNameSql} LIKE '%preferred stock%'
      OR ${lowerCompanyNameSql} LIKE '%preferred share%'
      OR ${lowerCompanyNameSql} LIKE '%preference share%'
      OR ${lowerCompanyNameSql} LIKE '% pfd%'
      OR ${lowerCompanyNameSql} LIKE 'pfd %'
      OR ${lowerCompanyNameSql} LIKE '%pfd.%'
      OR ${lowerCompanyNameSql} LIKE '%cumulative%'
      OR ${lowerCompanyNameSql} LIKE '%redeemable%'
      OR ${lowerCompanyNameSql} LIKE '%perpetual%'
      OR (
        ${lowerCompanyNameSql} LIKE '%preferred%'
        AND (
          ${lowerCompanyNameSql} LIKE '%series%'
          OR ${lowerCompanyNameSql} LIKE '%stock%'
          OR ${lowerCompanyNameSql} LIKE '%share%'
          OR ${lowerCompanyNameSql} LIKE '%depositary%'
        )
      )
      OR (
        ${lowerCompanyNameSql} LIKE '%depositary share%'
        AND (
          ${lowerCompanyNameSql} LIKE '%preferred%'
          OR ${lowerCompanyNameSql} LIKE '%preference%'
          OR ${lowerCompanyNameSql} LIKE '%series%'
          OR ${lowerCompanyNameSql} LIKE '%cumulative%'
          OR ${lowerCompanyNameSql} LIKE '%redeemable%'
          OR ${lowerCompanyNameSql} LIKE '%perpetual%'
        )
      )
    )`,
    `NOT (
      ${lowerCompanyNameSql} LIKE '% bond%'
      OR ${lowerCompanyNameSql} LIKE '% bonds%'
      OR ${lowerCompanyNameSql} LIKE '% note%'
      OR ${lowerCompanyNameSql} LIKE '% notes%'
      OR ${lowerCompanyNameSql} LIKE '%senior note%'
      OR ${lowerCompanyNameSql} LIKE '%subordinated note%'
      OR ${lowerCompanyNameSql} LIKE '%debenture%'
      OR ${lowerCompanyNameSql} LIKE '%baby bond%'
      OR ${lowerCompanyNameSql} LIKE '%fixed-rate%'
      OR ${lowerCompanyNameSql} LIKE '%fixed income%'
      OR ${lowerCompanyNameSql} LIKE '% due 20%'
    )`,
    `NOT (
      ${lowerCompanyNameSql} LIKE '% warrant%'
      OR ${lowerCompanyNameSql} LIKE '% warrants%'
      OR ${lowerCompanyNameSql} LIKE '% right%'
      OR ${lowerCompanyNameSql} LIKE '% rights%'
      OR ${lowerCompanyNameSql} LIKE '% unit%'
      OR ${lowerCompanyNameSql} LIKE '% units%'
      OR ${lowerCompanyNameSql} LIKE '% fund%'
      OR ${lowerCompanyNameSql} LIKE '% funds%'
      OR ${lowerCompanyNameSql} LIKE '% etf%'
      OR ${lowerCompanyNameSql} LIKE '% etfs%'
      OR ${lowerCompanyNameSql} LIKE '% etn%'
      OR ${lowerCompanyNameSql} LIKE '% etns%'
    )`,
  ];
  if (options.includeCatalog && tableName) clauses.push(earningsCatalogEligibilitySql(tableName));
  return `(${clauses.join(" AND ")})`;
}

export function earningsDefaultEligibleListedEquitySql(
  tableName?: string | null,
  options: { includeCatalog?: boolean } = {},
): string {
  return `(${earningsEligibleSecuritySql(tableName, options)} AND ${earningsMajorUsExchangeSql(tableName)})`;
}

export const EARNINGS_ELIGIBLE_ISSUE_SQL = earningsEligibleSecuritySql();

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
  if (PREFERRED_DEPOSITARY_TEXT_RE.test(text) && /\b(preferred|preference|series|cumulative|redeemable|perpetual)\b/i.test(text)) return true;
  return /\bpreferred\b/i.test(text) && PREFERRED_WITH_ISSUE_CONTEXT_RE.test(text);
}

export function hasDebtIssueText(value: unknown): boolean {
  const text = normalize(value);
  return Boolean(text && DEBT_ISSUE_TEXT_RE.test(text));
}

export function hasFundUnitRightIssueText(value: unknown): boolean {
  const text = normalize(value);
  return Boolean(text && FUND_UNIT_RIGHT_TEXT_RE.test(text));
}

export function isMajorUsExchange(value: unknown): boolean {
  return MAJOR_US_EXCHANGES.has(normalize(value).toUpperCase());
}

export function isEligibleEarningsCatalogSymbol(input: {
  isActive?: unknown;
  catalogManaged?: unknown;
  listingSource?: unknown;
  assetClass?: unknown;
}): boolean {
  const isActiveRaw = input.isActive;
  const isActive = isActiveRaw == null ? true : Number(isActiveRaw) !== 0;
  const catalogManaged = Number(input.catalogManaged ?? 0) === 1;
  const listingSource = normalize(input.listingSource).toLowerCase();
  const assetClass = normalize(input.assetClass || "equity").toLowerCase();
  return isActive && COMMON_EQUITY_ASSET_CLASSES.has(assetClass) && (catalogManaged || listingSource === "manual");
}

export function getEarningsIssueExclusionReasons(input: {
  ticker?: unknown;
  sourceSymbol?: unknown;
  companyName?: unknown;
  issueType?: unknown;
}): string[] {
  const reasons: string[] = [];
  if (hasPreferredShareTickerPattern(input.ticker) || hasPreferredShareTickerPattern(input.sourceSymbol)) {
    reasons.push("Preferred share ticker pattern");
  }
  if (hasPreferredIssueText(input.companyName)) reasons.push("Preferred/security text");
  if (hasDebtIssueText(input.companyName)) reasons.push("Debt/bond/note security text");
  if (hasFundUnitRightIssueText(input.companyName)) reasons.push("Fund/unit/warrant/right security text");
  if (EXCLUDED_ISSUE_TYPE_RE.test(normalize(input.issueType))) reasons.push("Excluded issue type");
  return reasons;
}

export function getEarningsEligibilityExclusionReasons(
  input: {
    ticker?: unknown;
    sourceSymbol?: unknown;
    companyName?: unknown;
    issueType?: unknown;
    exchange?: unknown;
    isActive?: unknown;
    catalogManaged?: unknown;
    listingSource?: unknown;
    assetClass?: unknown;
  },
  options: { enforceMajorExchange?: boolean; catalogActive?: boolean } = {},
): string[] {
  const reasons = getEarningsIssueExclusionReasons(input);
  if (options.enforceMajorExchange && !isMajorUsExchange(input.exchange)) {
    reasons.push("OTC or non-major exchange");
  }
  if (options.catalogActive && !isEligibleEarningsCatalogSymbol(input)) {
    reasons.push("Not in active Nasdaq Trader common-stock catalog");
  }
  return reasons;
}

export function isExcludedEarningsIssue(input: {
  ticker?: unknown;
  sourceSymbol?: unknown;
  companyName?: unknown;
  issueType?: unknown;
}): boolean {
  return getEarningsIssueExclusionReasons(input).length > 0;
}

async function tableExists(env: Env, tableName: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).bind(tableName).first<{ count: number | string | null }>();
  return Number(row?.count ?? 0) > 0;
}

async function columnExists(env: Env, tableName: string, columnName: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM pragma_table_info('${tableName}') WHERE name = ?`,
  ).bind(columnName).first<{ count: number | string | null }>();
  return Number(row?.count ?? 0) > 0;
}

export async function canUseEarningsSymbolCatalog(env: Env): Promise<boolean> {
  try {
    const [symbolsReady, isActiveReady, catalogManagedReady, listingSourceReady] = await Promise.all([
      tableExists(env, "symbols"),
      columnExists(env, "symbols", "is_active"),
      columnExists(env, "symbols", "catalog_managed"),
      columnExists(env, "symbols", "listing_source"),
    ]);
    return symbolsReady && isActiveReady && catalogManagedReady && listingSourceReady;
  } catch {
    return false;
  }
}

export async function hasActiveEarningsSymbolCatalog(env: Env): Promise<boolean> {
  if (!(await canUseEarningsSymbolCatalog(env))) return false;
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) as count
       FROM symbols
       WHERE COALESCE(catalog_managed, 0) = 1
         AND COALESCE(is_active, 1) = 1`,
    ).first<{ count: number | string | null }>();
    return Number(row?.count ?? 0) > 0;
  } catch {
    return false;
  }
}

export async function filterRowsByEarningsSymbolCatalog<T extends { ticker: string }>(
  env: Env,
  rows: T[],
): Promise<T[]> {
  if (rows.length === 0 || !(await hasActiveEarningsSymbolCatalog(env))) return rows;
  const tickers = Array.from(new Set(rows.map((row) => normalize(row.ticker).toUpperCase()).filter(Boolean)));
  if (tickers.length === 0) return [];
  const eligible = new Set<string>();
  for (let index = 0; index < tickers.length; index += 90) {
    const chunk = tickers.slice(index, index + 90);
    const result = await env.DB.prepare(
      `SELECT ticker
       FROM symbols
       WHERE UPPER(ticker) IN (${chunk.map(() => "?").join(",")})
         AND COALESCE(is_active, 1) = 1
         AND LOWER(COALESCE(asset_class, 'equity')) IN ('equity', 'stock', 'stocks', 'common_stock', 'common stock')
         AND (
           COALESCE(catalog_managed, 0) = 1
           OR COALESCE(listing_source, '') = 'manual'
         )`,
    ).bind(...chunk).all<{ ticker: string }>();
    for (const row of result.results ?? []) eligible.add(normalize(row.ticker).toUpperCase());
  }
  return rows.filter((row) => eligible.has(normalize(row.ticker).toUpperCase()));
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
