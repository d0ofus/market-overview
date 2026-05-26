import {
  canUseEarningsSymbolCatalog,
  earningsDefaultEligibleListedEquitySql,
  getEarningsEligibilityExclusionReasons,
  hasActiveEarningsSymbolCatalog,
} from "./earnings-issue-filter";
import { loadSymbolCatalogStatus, type SymbolCatalogSyncStatus } from "./symbol-directory-service";
import type { Env } from "./types";

export type EarningsExclusionsDataset = "surprises" | "gaps";

export type EarningsExcludedRow = {
  id: string;
  dataset: EarningsExclusionsDataset;
  provider: string;
  sourceSymbol: string;
  ticker: string;
  exchange: string | null;
  companyName: string | null;
  reportDate: string;
  metricLabel: string;
  metricValue: number | null;
  reasons: string[];
};

export type EarningsExclusionsResponse = {
  schemaReady: boolean;
  warning: string | null;
  generatedAt: string;
  dataset: EarningsExclusionsDataset;
  limit: number;
  offset: number;
  total: number;
  scanner: {
    primarySource: string;
    tradingViewMarket: string;
    tradingViewSymbolTypes: string[];
    backupProviders: string[];
    defaultExchangePolicy: string;
  };
  rules: string[];
  catalog: SymbolCatalogSyncStatus | null;
  rows: EarningsExcludedRow[];
};

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 250;

function normalizeLimit(value: number | null | undefined): number {
  const parsed = Number(value ?? DEFAULT_LIMIT);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(parsed)));
}

function normalizeOffset(value: number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

async function tableExists(env: Env, tableName: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).bind(tableName).first<{ count: number | string | null }>();
  return Number(row?.count ?? 0) > 0;
}

function parseMaybeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function datasetConfig(dataset: EarningsExclusionsDataset): {
  tableName: "earnings_surprise_events" | "earnings_gap_events";
  schemaWarning: string;
  metricColumn: string;
  metricLabel: string;
  backupProviders: string[];
} {
  if (dataset === "gaps") {
    return {
      tableName: "earnings_gap_events",
      schemaWarning: "Earnings gap schema is missing. Apply worker/migrations/0052_earnings_gaps.sql.",
      metricColumn: "qualifying_gap_pct",
      metricLabel: "Gap %",
      backupProviders: [],
    };
  }
  return {
    tableName: "earnings_surprise_events",
    schemaWarning: "Earnings surprise schema is missing. Apply worker/migrations/0051_earnings_surprises.sql.",
    metricColumn: "eps_surprise_pct",
    metricLabel: "EPS surprise %",
    backupProviders: ["FMP", "Finnhub"],
  };
}

async function loadCatalogStatusSafe(env: Env): Promise<SymbolCatalogSyncStatus | null> {
  try {
    return await loadSymbolCatalogStatus(env);
  } catch {
    return null;
  }
}

function scannerSummary(backupProviders: string[]): EarningsExclusionsResponse["scanner"] {
  return {
    primarySource: "https://scanner.tradingview.com/america/scan",
    tradingViewMarket: "america",
    tradingViewSymbolTypes: ["stock"],
    backupProviders,
    defaultExchangePolicy: "NASDAQ, NYSE, and AMEX only unless includeOtc is requested.",
  };
}

function eligibilityRules(): string[] {
  return [
    "Exclude preferred-share ticker suffixes such as /P, .P, -P, and $P.",
    "Exclude preferred/security text such as preferred, pfd, cumulative, redeemable, perpetual, and preferred depositary-share issues.",
    "Exclude debt-like securities such as bonds, senior notes, debentures, baby bonds, fixed-rate issues, and due-date notes.",
    "Exclude warrants, rights, units, funds, ETFs, and ETNs.",
    "Exclude OTC or non-major exchanges from default earnings outputs.",
    "When the Nasdaq Trader common-stock catalog is populated, require an active catalog-managed or manual common-equity symbol.",
  ];
}

export async function loadEarningsExclusions(
  env: Env,
  input: { dataset?: string | null; limit?: number | null; offset?: number | null } = {},
): Promise<EarningsExclusionsResponse> {
  const dataset: EarningsExclusionsDataset = input.dataset === "gaps" ? "gaps" : "surprises";
  const limit = normalizeLimit(input.limit);
  const offset = normalizeOffset(input.offset);
  const config = datasetConfig(dataset);
  const catalog = await loadCatalogStatusSafe(env);
  if (!(await tableExists(env, config.tableName))) {
    return {
      schemaReady: false,
      warning: config.schemaWarning,
      generatedAt: new Date().toISOString(),
      dataset,
      limit,
      offset,
      total: 0,
      scanner: scannerSummary(config.backupProviders),
      rules: eligibilityRules(),
      catalog,
      rows: [],
    };
  }

  const includeCatalog = await canUseEarningsSymbolCatalog(env);
  const catalogActive = includeCatalog && await hasActiveEarningsSymbolCatalog(env);
  const eligibilitySql = earningsDefaultEligibleListedEquitySql(config.tableName, { includeCatalog });
  const catalogSelect = includeCatalog
    ? `symbols.is_active as catalogIsActive,
       symbols.catalog_managed as catalogManaged,
       symbols.listing_source as listingSource,
       symbols.asset_class as assetClass`
    : `NULL as catalogIsActive,
       NULL as catalogManaged,
       NULL as listingSource,
       NULL as assetClass`;
  const catalogJoin = includeCatalog
    ? `LEFT JOIN symbols ON UPPER(symbols.ticker) = UPPER(${config.tableName}.ticker)`
    : "";

  const count = await env.DB.prepare(
    `SELECT COUNT(*) as count
     FROM ${config.tableName}
     ${catalogJoin}
     WHERE NOT ${eligibilitySql}`,
  ).first<{ count: number | string | null }>();

  const rows = await env.DB.prepare(
    `SELECT
       ${config.tableName}.id,
       ${config.tableName}.provider,
       ${config.tableName}.source_symbol as sourceSymbol,
       ${config.tableName}.ticker,
       ${config.tableName}.exchange,
       ${config.tableName}.company_name as companyName,
       ${config.tableName}.report_date as reportDate,
       ${config.tableName}.${config.metricColumn} as metricValue,
       ${catalogSelect}
     FROM ${config.tableName}
     ${catalogJoin}
     WHERE NOT ${eligibilitySql}
     ORDER BY ${config.tableName}.report_date DESC, ${config.tableName}.ticker ASC
     LIMIT ? OFFSET ?`,
  ).bind(limit, offset).all<Record<string, unknown>>();

  return {
    schemaReady: true,
    warning: null,
    generatedAt: new Date().toISOString(),
    dataset,
    limit,
    offset,
    total: Number(count?.count ?? 0),
    scanner: scannerSummary(config.backupProviders),
    rules: eligibilityRules(),
    catalog,
    rows: (rows.results ?? []).map((row) => {
      const reasons = getEarningsEligibilityExclusionReasons({
        ticker: row.ticker,
        sourceSymbol: row.sourceSymbol,
        companyName: row.companyName,
        exchange: row.exchange,
        isActive: row.catalogIsActive,
        catalogManaged: row.catalogManaged,
        listingSource: row.listingSource,
        assetClass: row.assetClass,
      }, { enforceMajorExchange: true, catalogActive });
      return {
        id: String(row.id ?? ""),
        dataset,
        provider: String(row.provider ?? ""),
        sourceSymbol: String(row.sourceSymbol ?? ""),
        ticker: String(row.ticker ?? ""),
        exchange: row.exchange == null ? null : String(row.exchange),
        companyName: row.companyName == null ? null : String(row.companyName),
        reportDate: String(row.reportDate ?? ""),
        metricLabel: config.metricLabel,
        metricValue: parseMaybeNumber(row.metricValue),
        reasons: reasons.length > 0 ? reasons : ["Excluded by earnings eligibility SQL"],
      };
    }),
  };
}
