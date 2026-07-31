export type BreadthQualityRow = {
  universeId?: unknown;
  asOfDate?: unknown;
  advancers?: unknown;
  decliners?: unknown;
  unchanged?: unknown;
  metrics?: unknown;
  provenance?: unknown;
};

export const BREADTH_UNIVERSE_MEMBER_RANGES: Record<string, { min: number; max: number }> = {
  "sp500-core": { min: 480, max: 525 },
  "nasdaq-core": { min: 2_500, max: 5_000 },
  "nyse-core": { min: 1_500, max: 3_500 },
  "russell2000-core": { min: 1_800, max: 2_100 },
  "overall-market-proxy": { min: 4_000, max: 8_000 },
};

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function breadthUniverseMemberCount(row: BreadthQualityRow): number {
  const metrics = row.metrics && typeof row.metrics === "object"
    ? row.metrics as Record<string, unknown>
    : {};
  return finiteNumber(metrics.totalUniverseMembers)
    ?? finiteNumber(metrics.memberCount)
    ?? ((finiteNumber(row.advancers) ?? 0) + (finiteNumber(row.decliners) ?? 0) + (finiteNumber(row.unchanged) ?? 0));
}

export function isBreadthUniverseMemberCountValid(universeId: unknown, count: number): boolean {
  const range = BREADTH_UNIVERSE_MEMBER_RANGES[String(universeId ?? "")];
  return range ? count >= range.min && count <= range.max : count > 0;
}

export function isUsableBreadthRow(row: BreadthQualityRow): boolean {
  const count = breadthUniverseMemberCount(row);
  const metrics = row.metrics && typeof row.metrics === "object"
    ? row.metrics as Record<string, unknown>
    : {};
  const coveragePct = finiteNumber(metrics.dataCoveragePct);
  const minCoveragePct = String(row.universeId ?? "") === "sp500-core" ? 98 : 95;
  const provenance = row.provenance && typeof row.provenance === "object"
    ? row.provenance as Record<string, unknown>
    : {};
  const sourceAsOfDate = typeof provenance.sourceAsOfDate === "string" ? provenance.sourceAsOfDate : null;
  const snapshotMs = typeof row.asOfDate === "string" ? Date.parse(`${row.asOfDate}T00:00:00Z`) : Number.NaN;
  const sourceMs = sourceAsOfDate ? Date.parse(`${sourceAsOfDate}T00:00:00Z`) : Number.NaN;
  const sourceAgeDays = Number.isFinite(snapshotMs) && Number.isFinite(sourceMs)
    ? Math.floor((snapshotMs - sourceMs) / 86_400_000)
    : Number.POSITIVE_INFINITY;
  const sourceProvenanceUsable = String(row.universeId ?? "") !== "russell2000-core"
    || (sourceAgeDays >= -1 && sourceAgeDays <= 14);
  return Number.isFinite(count)
    && isBreadthUniverseMemberCountValid(row.universeId, count)
    && coveragePct != null
    && coveragePct >= minCoveragePct
    && sourceProvenanceUsable;
}

export function latestUsableBreadthDate(rows: BreadthQualityRow[]): string | null {
  return rows.reduce<string | null>((latest, row) => {
    if (!isUsableBreadthRow(row) || typeof row.asOfDate !== "string") return latest;
    return latest == null || row.asOfDate > latest ? row.asOfDate : latest;
  }, null);
}

export function isCurrentUsableBreadthRow(row: BreadthQualityRow, latestDate: string | null): boolean {
  return isUsableBreadthRow(row) && latestDate != null && row.asOfDate === latestDate;
}
