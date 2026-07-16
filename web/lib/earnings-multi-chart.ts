import type {
  EarningsGapRow,
  EarningsGapsQuery,
  EarningsSurpriseRow,
  EarningsSurprisesQuery,
} from "./api";

export type EarningsResultView = "table" | "grid";
export type EarningsGridKind = "surprises" | "gaps";

export type EarningsGridMetric = {
  label: string;
  value: string;
  rawValue?: number | null;
};

export type EarningsGridCard = {
  id: string;
  ticker: string;
  reportDate: string;
  primaryMetrics: EarningsGridMetric[];
  signedMetrics: EarningsGridMetric[];
  expandedMetrics: EarningsGridMetric[];
};

export function normalizeEarningsResultView(value: unknown): EarningsResultView {
  return value === "grid" ? "grid" : "table";
}

export function buildEarningsGridQuery<T extends EarningsSurprisesQuery | EarningsGapsQuery>(
  query: T,
  page: number,
  pageSize: number,
): T & { limit: number; offset: number } {
  const safePageSize = Math.max(1, Math.min(48, Math.round(pageSize) || 12));
  const safePage = Math.max(1, Math.round(page) || 1);
  return {
    ...query,
    limit: safePageSize,
    offset: (safePage - 1) * safePageSize,
  };
}

export function formatEarningsGridCompact(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

export function formatEarningsGridPct(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function metric(label: string, value: string, rawValue?: number | null): EarningsGridMetric {
  return { label, value, rawValue };
}

export function surpriseRowToGridCard(row: EarningsSurpriseRow): EarningsGridCard {
  const industry = metric("Industry", row.industry ?? "-");
  const marketCap = metric("Mkt Cap", formatEarningsGridCompact(row.marketCap));
  const dollarVolume = metric("$ Volume", formatEarningsGridCompact(row.avgDollarVolume30d));
  const reportDate = metric("Report Date", row.reportDate || "-");
  const eps = metric("EPS %", formatEarningsGridPct(row.epsSurprisePct), row.epsSurprisePct);
  const revenue = metric("Rev %", formatEarningsGridPct(row.revenueSurprisePct), row.revenueSurprisePct);
  return {
    id: row.id,
    ticker: row.ticker,
    reportDate: row.reportDate,
    primaryMetrics: [industry, marketCap, dollarVolume],
    signedMetrics: [eps, revenue],
    expandedMetrics: [reportDate, industry, marketCap, dollarVolume, eps, revenue],
  };
}

export function gapRowToGridCard(row: EarningsGapRow): EarningsGridCard {
  const industry = metric("Industry", row.industry ?? "-");
  const marketCap = metric("Mkt Cap", formatEarningsGridCompact(row.marketCap));
  const dollarVolume = metric("$ Volume", formatEarningsGridCompact(row.avgDollarVolume30d));
  const reportDate = metric("Report Date", row.reportDate || "-");
  const bestGap = metric("Best Gap", formatEarningsGridPct(row.qualifyingGapPct), row.qualifyingGapPct);
  const eps = metric("EPS %", formatEarningsGridPct(row.epsSurprisePct), row.epsSurprisePct);
  return {
    id: row.id,
    ticker: row.ticker,
    reportDate: row.reportDate,
    primaryMetrics: [industry, marketCap, dollarVolume],
    signedMetrics: [bestGap, eps],
    expandedMetrics: [reportDate, industry, marketCap, dollarVolume, bestGap, eps],
  };
}

export function earningsGridMetricClass(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "text-slate-100";
  return value < 0 ? "text-neg" : "text-pos";
}
