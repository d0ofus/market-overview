export type EtfSyncStatusRow = {
  etfTicker: string;
  lastSyncedAt: string | null;
  status: string | null;
  error: string | null;
  source: string | null;
  recordsCount: number | null;
  updatedAt?: string | null;
  coverage?: string | null;
  sourceTier?: string | null;
  sourceUrl?: string | null;
  providerRecordsCount?: number | null;
  expectedMinRecords?: number | null;
  lastFullSyncedAt?: string | null;
  lastPartialSyncedAt?: string | null;
  actualRecordsCount?: number | null;
  latestConstituentUpdatedAt?: string | null;
};

export function normalizeEtfSyncStatusRow<T extends EtfSyncStatusRow>(row: T): T {
  const actualRecordsCount = Number(row.actualRecordsCount ?? row.recordsCount ?? 0);
  const effectiveRecordsCount = Number.isFinite(actualRecordsCount) ? Math.max(0, actualRecordsCount) : 0;
  const hasCachedConstituents = effectiveRecordsCount > 0;
  const hasPartialCoverage = row.coverage === "partial" || row.sourceTier === "partial" || row.status === "partial";
  const effectiveStatus = row.status ?? (hasCachedConstituents ? (hasPartialCoverage ? "partial" : "ok") : "pending");
  const effectiveError = row.error ?? null;
  const effectiveUpdatedAt = row.updatedAt ?? row.latestConstituentUpdatedAt ?? null;
  const effectiveLastSyncedAt = row.lastSyncedAt ?? row.latestConstituentUpdatedAt ?? row.lastFullSyncedAt ?? row.lastPartialSyncedAt ?? null;
  return {
    ...row,
    status: effectiveStatus,
    error: effectiveError,
    recordsCount: effectiveRecordsCount,
    updatedAt: effectiveUpdatedAt,
    lastSyncedAt: effectiveLastSyncedAt,
  };
}
