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
  const storedRecordsCount = Number(row.recordsCount ?? 0);
  const effectiveRecordsCount = Math.max(actualRecordsCount, storedRecordsCount);
  const hasCachedConstituents = effectiveRecordsCount > 0;
  const hasPartialCoverage = row.coverage === "partial" || row.sourceTier === "partial" || row.status === "partial";
  const hasStaleError = row.status === "error" && hasCachedConstituents;
  const effectiveStatus = hasStaleError
    ? (hasPartialCoverage ? "partial" : "ok")
    : (row.status ?? (hasCachedConstituents ? (hasPartialCoverage ? "partial" : "ok") : "pending"));
  const effectiveError = hasStaleError ? null : (row.error ?? null);
  const effectiveUpdatedAt = row.latestConstituentUpdatedAt ?? row.updatedAt ?? null;
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
