import type {
  EarningsGapRow,
  EarningsGapsQuery,
  EarningsSurpriseRow,
  EarningsSurprisesQuery,
} from "./api";

export type EarningsSnapshotSortKey =
  | "reportDate"
  | "ticker"
  | "companyName"
  | "season"
  | "epsSurprisePct"
  | "epsSurprise"
  | "revenueSurprisePct"
  | "qualifyingGapPct"
  | "postmarketGapPct"
  | "regularOpenGapPct"
  | "avgDollarVolume30d"
  | "marketCap"
  | "gapSource"
  | "sector"
  | "industry"
  | "exchange";

type EarningsSnapshotRow = EarningsSurpriseRow | EarningsGapRow;

export function earningsSnapshotFilterQuery<T extends EarningsSurprisesQuery | EarningsGapsQuery>(
  query: T,
): Omit<T, "limit" | "offset" | "sort" | "sortDir"> {
  const next = { ...query };
  delete next.limit;
  delete next.offset;
  delete next.sort;
  delete next.sortDir;
  return next;
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function normalizedValue(row: EarningsSnapshotRow, key: EarningsSnapshotSortKey): string | number | null {
  const value = (row as unknown as Record<string, unknown>)[key];
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return value;
  return null;
}

function compareNullable(
  left: string | number | null,
  right: string | number | null,
  direction: "asc" | "desc",
): number {
  if (left == null && right == null) return 0;
  if (left == null) return direction === "asc" ? -1 : 1;
  if (right == null) return direction === "asc" ? 1 : -1;
  const compared = typeof left === "number" && typeof right === "number"
    ? left - right
    : compareText(String(left), String(right));
  return direction === "asc" ? compared : -compared;
}

export function sortEarningsSnapshotRows<Row extends EarningsSnapshotRow>(
  rows: readonly Row[],
  sortKey: EarningsSnapshotSortKey,
  sortDir: "asc" | "desc",
): Row[] {
  return [...rows].sort((left, right) => (
    compareNullable(normalizedValue(left, sortKey), normalizedValue(right, sortKey), sortDir)
    || compareText(left.ticker, right.ticker)
    || compareText(right.reportDate, left.reportDate)
    || compareText(left.id, right.id)
  ));
}

export function sliceEarningsSnapshotRows<Row>(
  rows: readonly Row[],
  limit: number,
  offset: number,
): Row[] {
  if (limit === 0) return [...rows];
  const safeLimit = Math.max(1, Math.floor(limit));
  const safeOffset = Math.max(0, Math.floor(offset));
  return rows.slice(safeOffset, safeOffset + safeLimit);
}
