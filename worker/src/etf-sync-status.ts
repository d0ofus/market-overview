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

/** Callers already loaded the complete holdings snapshot (or its indexed
 * summary). Reuse that count instead of aggregating every fund on each read. */
export async function loadEtfSyncStatus(db: D1Database, ticker: string, observed: {
  actualRecordsCount: number; latestConstituentUpdatedAt: string | null;
}): Promise<EtfSyncStatusRow | null> {
  if (!Number.isSafeInteger(observed.actualRecordsCount) || observed.actualRecordsCount < 0) {
    throw new Error("holdings-observed-count-invalid");
  }
  const columns = "etf_ticker AS etfTicker,last_synced_at AS lastSyncedAt,status,error,source,records_count AS recordsCount,updated_at AS updatedAt";
  let row: EtfSyncStatusRow | null;
  try {
    row = await db.prepare(`SELECT ${columns},coverage,source_tier AS sourceTier,source_url AS sourceUrl,
      provider_records_count AS providerRecordsCount,expected_min_records AS expectedMinRecords,
      last_full_synced_at AS lastFullSyncedAt,last_partial_synced_at AS lastPartialSyncedAt
      FROM etf_constituent_sync_status WHERE etf_ticker=?`).bind(ticker).first<EtfSyncStatusRow>();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    // Only the known legacy schema needs a second query. Quota, transport and
    // other database failures retain their original error and are not retried.
    if (!/no such column:\s*(?:coverage|source_tier|source_url|provider_records_count|expected_min_records|last_full_synced_at|last_partial_synced_at)\b/i.test(message)) throw error;
    row = await db.prepare(`SELECT ${columns} FROM etf_constituent_sync_status WHERE etf_ticker=?`)
      .bind(ticker).first<EtfSyncStatusRow>();
  }
  if (!row && observed.actualRecordsCount === 0) return null;
  return normalizeEtfSyncStatusRow({
    ...(row ?? { etfTicker: ticker, lastSyncedAt: observed.latestConstituentUpdatedAt,
      status: null, error: null, source: null, recordsCount: 0, updatedAt: observed.latestConstituentUpdatedAt }),
    ...observed,
  });
}
