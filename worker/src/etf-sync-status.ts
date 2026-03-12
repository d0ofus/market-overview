export type EtfSyncStatusRow = {
  etfTicker: string;
  lastSyncedAt: string | null;
  status: string | null;
  error: string | null;
  source: string | null;
  recordsCount: number;
  updatedAt: string | null;
  actualRecordsCount?: number | null;
  latestConstituentUpdatedAt?: string | null;
};

export function normalizeEtfSyncStatusRow<T extends EtfSyncStatusRow>(row: T): T {
  const actualRecordsCount = Number(row.actualRecordsCount ?? row.recordsCount ?? 0);
  const storedRecordsCount = Number(row.recordsCount ?? 0);
  const effectiveRecordsCount = Math.max(actualRecordsCount, storedRecordsCount);
  const hasCachedConstituents = effectiveRecordsCount > 0;
  const hasStaleError = row.status === "error" && hasCachedConstituents;
  const effectiveStatus = hasStaleError
    ? "ok"
    : (row.status ?? (hasCachedConstituents ? "ok" : "pending"));
  const effectiveError = hasStaleError ? null : (row.error ?? null);
  const effectiveUpdatedAt = row.latestConstituentUpdatedAt ?? row.updatedAt ?? null;
  const effectiveLastSyncedAt = row.lastSyncedAt ?? row.latestConstituentUpdatedAt ?? null;
  return {
    ...row,
    status: effectiveStatus,
    error: effectiveError,
    recordsCount: effectiveRecordsCount,
    updatedAt: effectiveUpdatedAt,
    lastSyncedAt: effectiveLastSyncedAt,
  };
}
