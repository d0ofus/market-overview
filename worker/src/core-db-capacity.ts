import type { Env } from "./types";

const DEFAULT_WARN_BYTES = 350_000_000;
const DEFAULT_CRITICAL_BYTES = 425_000_000;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

export function isCoreDatabaseCapacityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /Exceeded maximum DB size|maximum account storage limit|database has exceeded its storage limit/i.test(message);
}

export function normalizeScanStorageError(error: unknown, fallback = "Scan refresh failed."): string {
  if (isCoreDatabaseCapacityError(error)) {
    return "Core D1 storage is full; the new scan was not saved. The previous usable snapshot remains active. Archive and purge legacy daily bars, then retry.";
  }
  return error instanceof Error ? error.message : fallback;
}

export function inspectCoreDatabaseSize(
  env: Env,
  sizeAfter: number | undefined,
  operation: string,
): void {
  if (!Number.isFinite(sizeAfter)) return;
  const sizeBytes = Number(sizeAfter);
  const warnBytes = positiveInteger(env.CORE_DB_WARN_BYTES, DEFAULT_WARN_BYTES);
  const criticalBytes = Math.max(
    warnBytes,
    positiveInteger(env.CORE_DB_CRITICAL_BYTES, DEFAULT_CRITICAL_BYTES),
  );
  if (sizeBytes < warnBytes) return;
  console.warn("market_command D1 capacity warning", {
    database: "market_command",
    operation,
    level: sizeBytes >= criticalBytes ? "critical" : "warning",
    sizeBytes,
    warnBytes,
    criticalBytes,
  });
}

export function inspectCoreDatabaseResults(
  env: Env,
  results: Array<D1Result<unknown>>,
  operation: string,
): void {
  for (const result of results) inspectCoreDatabaseSize(env, result.meta?.size_after, operation);
}
