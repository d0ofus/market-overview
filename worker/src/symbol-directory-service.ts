import { loadNasdaqTraderCommonStocks, type NasdaqTraderCommonStock } from "./universe-constituents";
import { resolveTickerMeta, type ResolvedSymbol } from "./symbol-resolver";
import type { Env } from "./types";

type CountRow = { count: number };
type ExistingSymbolRow = {
  ticker: string;
  isActive: number | null;
  listingSource: string | null;
  catalogManaged: number | null;
};
type CatalogCountsRow = {
  totalCount: number | null;
  activeCount: number | null;
  inactiveCount: number | null;
  manualCount: number | null;
  catalogManagedCount: number | null;
};
type ScheduleEnabledRow = { count: number };

export type SymbolCatalogSyncStatus = {
  sourceKey: string;
  scheduledEnabled: boolean;
  schemaReady: boolean;
  lastSyncedAt: string | null;
  status: string | null;
  error: string | null;
  recordsCount: number | null;
  updatedAt: string | null;
  totalCount: number;
  activeCount: number;
  inactiveCount: number;
  manualCount: number;
  catalogManagedCount: number;
};

export type SymbolCatalogSyncResult = {
  sourceKey: string;
  trigger: "manual" | "scheduled";
  fetched: number;
  inserted: number;
  updated: number;
  reactivated: number;
  deactivated: number;
  completedAt: string;
  status: "ok";
};

export const SYMBOL_CATALOG_SOURCE_KEY = "nasdaqtrader-us-common-stocks";
const DAILY_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 200;
const SQL_VARIABLE_BATCH_SIZE = 90;

function normalizeTicker(value: string): string {
  return String(value ?? "").trim().toUpperCase();
}

function isTruthyEnvFlag(value: string | null | undefined): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

async function tableExists(env: Env, tableName: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).bind(tableName).first<CountRow>();
  return Number(row?.count ?? 0) > 0;
}

async function columnExists(env: Env, tableName: string, columnName: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM pragma_table_info('${tableName}') WHERE name = ?`,
  ).bind(columnName).first<CountRow>();
  return Number(row?.count ?? 0) > 0;
}

async function runStatementsInChunks(env: Env, statements: D1PreparedStatement[], chunkSize = BATCH_SIZE): Promise<void> {
  for (let index = 0; index < statements.length; index += chunkSize) {
    const chunk = statements.slice(index, index + chunkSize);
    if (chunk.length === 0) continue;
    await env.DB.batch(chunk);
  }
}

async function loadExistingSymbolStateMap(env: Env, tickers: string[]): Promise<Map<string, ExistingSymbolRow>> {
  const map = new Map<string, ExistingSymbolRow>();
  const unique = Array.from(new Set(tickers.map(normalizeTicker).filter(Boolean)));
  for (let index = 0; index < unique.length; index += SQL_VARIABLE_BATCH_SIZE) {
    const chunk = unique.slice(index, index + SQL_VARIABLE_BATCH_SIZE);
    if (chunk.length === 0) continue;
    const rows = await env.DB.prepare(
      `SELECT
        ticker,
        is_active as isActive,
        listing_source as listingSource,
        catalog_managed as catalogManaged
      FROM symbols
      WHERE ticker IN (${chunk.map(() => "?").join(",")})`,
    )
      .bind(...chunk)
      .all<ExistingSymbolRow>();
    for (const row of rows.results ?? []) {
      map.set(normalizeTicker(row.ticker), row);
    }
  }
  return map;
}

async function markCatalogSyncRunning(env: Env): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO symbol_catalog_sync_status (source_key, last_synced_at, status, error, records_count, updated_at, scheduled_enabled)
     VALUES (?, NULL, 'running', NULL, 0, CURRENT_TIMESTAMP, ?)
     ON CONFLICT(source_key) DO UPDATE SET
       status = 'running',
       error = NULL,
       records_count = 0,
       updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(SYMBOL_CATALOG_SOURCE_KEY, isSymbolCatalogSyncEnabledFromEnv(env) ? 1 : 0)
    .run();
}

async function markCatalogSyncSuccess(env: Env, completedAt: string, recordsCount: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO symbol_catalog_sync_status (source_key, last_synced_at, status, error, records_count, updated_at, scheduled_enabled)
     VALUES (?, ?, 'ok', NULL, ?, CURRENT_TIMESTAMP, ?)
     ON CONFLICT(source_key) DO UPDATE SET
       last_synced_at = excluded.last_synced_at,
       status = 'ok',
       error = NULL,
       records_count = excluded.records_count,
       updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(SYMBOL_CATALOG_SOURCE_KEY, completedAt, recordsCount, isSymbolCatalogSyncEnabledFromEnv(env) ? 1 : 0)
    .run();
}

async function markCatalogSyncError(env: Env, errorMessage: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO symbol_catalog_sync_status (source_key, last_synced_at, status, error, records_count, updated_at, scheduled_enabled)
     VALUES (?, NULL, 'error', ?, 0, CURRENT_TIMESTAMP, ?)
     ON CONFLICT(source_key) DO UPDATE SET
       status = 'error',
       error = excluded.error,
       records_count = 0,
       updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(SYMBOL_CATALOG_SOURCE_KEY, errorMessage.slice(0, 700), isSymbolCatalogSyncEnabledFromEnv(env) ? 1 : 0)
    .run();
}

function mapExistingExchange(code: string | null | undefined): string | null {
  const normalized = String(code ?? "").trim().toUpperCase();
  if (!normalized) return null;
  if (normalized === "Q") return "NASDAQ";
  if (normalized === "N") return "NYSE";
  if (normalized === "A") return "AMEX";
  if (normalized === "P") return "NYSE ARCA";
  if (normalized === "Z") return "BATS";
  if (normalized === "V") return "IEX";
  return normalized;
}

function toCatalogUpsertStatement(env: Env, row: NasdaqTraderCommonStock, catalogSeenAt: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO symbols (
       ticker,
       name,
       exchange,
       asset_class,
       sector,
       industry,
       updated_at,
       is_active,
       catalog_managed,
       listing_source,
       catalog_last_seen_at,
       deactivated_at
     )
     VALUES (?, ?, ?, 'equity', NULL, NULL, CURRENT_TIMESTAMP, 1, 1, 'nasdaqtrader', ?, NULL)
     ON CONFLICT(ticker) DO UPDATE SET
       name = CASE
         WHEN COALESCE(excluded.name, '') <> '' THEN excluded.name
         ELSE symbols.name
       END,
       exchange = COALESCE(excluded.exchange, symbols.exchange),
       asset_class = CASE
         WHEN symbols.asset_class IS NULL OR symbols.asset_class IN ('equity', 'stock', 'unsupported') THEN excluded.asset_class
         ELSE symbols.asset_class
       END,
       updated_at = CURRENT_TIMESTAMP,
       is_active = 1,
       catalog_managed = 1,
       listing_source = CASE
         WHEN COALESCE(symbols.listing_source, '') = 'manual' THEN 'manual'
         ELSE 'nasdaqtrader'
       END,
       catalog_last_seen_at = excluded.catalog_last_seen_at,
       deactivated_at = NULL`,
  )
    .bind(
      normalizeTicker(row.symbol),
      row.securityName.trim() || normalizeTicker(row.symbol),
      mapExistingExchange(row.listingExchange),
      catalogSeenAt,
    );
}

async function requireSymbolDirectorySchema(env: Env): Promise<void> {
  const [lifecycleReady, statusReady] = await Promise.all([
    hasSymbolDirectoryLifecycleColumns(env),
    hasSymbolCatalogSyncStatusTable(env),
  ]);
  if (!lifecycleReady || !statusReady) {
    throw new Error("Symbol directory schema is missing. Apply migration 0032_symbol_directory.sql first.");
  }
}

function isSymbolCatalogSyncEnabledFromEnv(env: Env): boolean {
  return isTruthyEnvFlag(env.SYMBOL_CATALOG_SYNC_ENABLED);
}

async function hasScheduledEnabledColumn(env: Env): Promise<boolean> {
  return await columnExists(env, "symbol_catalog_sync_status", "scheduled_enabled");
}

export async function isSymbolCatalogSyncEnabled(env: Env): Promise<boolean> {
  const statusTableReady = await hasSymbolCatalogSyncStatusTable(env);
  if (!statusTableReady) return isSymbolCatalogSyncEnabledFromEnv(env);
  const scheduledEnabledColumnReady = await hasScheduledEnabledColumn(env);
  if (!scheduledEnabledColumnReady) return isSymbolCatalogSyncEnabledFromEnv(env);
  const row = await env.DB.prepare(
    "SELECT scheduled_enabled as count FROM symbol_catalog_sync_status WHERE source_key = ? LIMIT 1",
  )
    .bind(SYMBOL_CATALOG_SOURCE_KEY)
    .first<ScheduleEnabledRow>();
  if (row == null) return isSymbolCatalogSyncEnabledFromEnv(env);
  return Number(row.count ?? 0) === 1;
}

export async function setSymbolCatalogSyncEnabled(env: Env, enabled: boolean): Promise<boolean> {
  await requireSymbolDirectorySchema(env);
  const scheduledEnabledColumnReady = await hasScheduledEnabledColumn(env);
  if (!scheduledEnabledColumnReady) {
    throw new Error("Symbol catalog schedule toggle schema is missing. Apply migration 0033_symbol_catalog_schedule_toggle.sql first.");
  }
  await env.DB.prepare(
    `INSERT INTO symbol_catalog_sync_status (
       source_key,
       last_synced_at,
       status,
       error,
       records_count,
       updated_at,
       scheduled_enabled
     )
     VALUES (?, NULL, NULL, NULL, 0, CURRENT_TIMESTAMP, ?)
     ON CONFLICT(source_key) DO UPDATE SET
       scheduled_enabled = excluded.scheduled_enabled,
       updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(SYMBOL_CATALOG_SOURCE_KEY, enabled ? 1 : 0)
    .run();
  return enabled;
}

export function isSymbolCatalogSyncDue(lastSyncedAt: string | null | undefined, now = new Date()): boolean {
  if (!lastSyncedAt) return true;
  const last = new Date(lastSyncedAt).getTime();
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= DAILY_SYNC_INTERVAL_MS;
}

export async function hasSymbolDirectoryLifecycleColumns(env: Env): Promise<boolean> {
  return await columnExists(env, "symbols", "is_active");
}

export async function hasSymbolCatalogSyncStatusTable(env: Env): Promise<boolean> {
  return await tableExists(env, "symbol_catalog_sync_status");
}

export async function addManualSymbolToDirectory(
  env: Env,
  tickerInput: string,
): Promise<{ resolved: ResolvedSymbol; created: boolean; reactivated: boolean }> {
  await requireSymbolDirectorySchema(env);
  const resolved = await resolveTickerMeta(tickerInput, env);
  if (!resolved) throw new Error("Ticker not found.");

  const existing = await env.DB.prepare(
    "SELECT ticker, is_active as isActive FROM symbols WHERE ticker = ? LIMIT 1",
  )
    .bind(resolved.ticker)
    .first<{ ticker: string; isActive: number | null }>();

  await env.DB.prepare(
    `INSERT INTO symbols (
       ticker,
       name,
       exchange,
       asset_class,
       updated_at,
       is_active,
       catalog_managed,
       listing_source,
       catalog_last_seen_at,
       deactivated_at
     )
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, 1, 0, 'manual', NULL, NULL)
     ON CONFLICT(ticker) DO UPDATE SET
       name = COALESCE(excluded.name, symbols.name),
       exchange = COALESCE(excluded.exchange, symbols.exchange),
       asset_class = COALESCE(excluded.asset_class, symbols.asset_class),
       updated_at = CURRENT_TIMESTAMP,
       is_active = 1,
       catalog_managed = 0,
       listing_source = 'manual',
       catalog_last_seen_at = NULL,
       deactivated_at = NULL`,
  )
    .bind(resolved.ticker, resolved.name, resolved.exchange ?? null, resolved.assetClass)
    .run();

  return {
    resolved,
    created: !existing,
    reactivated: Boolean(existing) && Number(existing?.isActive ?? 1) === 0,
  };
}

export async function loadSymbolCatalogStatus(env: Env): Promise<SymbolCatalogSyncStatus> {
  const [lifecycleReady, statusReady] = await Promise.all([
    hasSymbolDirectoryLifecycleColumns(env),
    hasSymbolCatalogSyncStatusTable(env),
  ]);
  const scheduledEnabledColumnReady = statusReady ? await hasScheduledEnabledColumn(env) : false;

  const statusRow = statusReady
    ? await env.DB.prepare(
      `SELECT
        source_key as sourceKey,
        last_synced_at as lastSyncedAt,
        status,
        error,
        records_count as recordsCount,
        updated_at as updatedAt
        ${scheduledEnabledColumnReady ? ", scheduled_enabled as scheduledEnabled" : ""}
      FROM symbol_catalog_sync_status
      WHERE source_key = ?
      LIMIT 1`,
    )
      .bind(SYMBOL_CATALOG_SOURCE_KEY)
      .first<{
        sourceKey: string;
        lastSyncedAt: string | null;
        status: string | null;
        error: string | null;
        recordsCount: number | null;
        updatedAt: string | null;
        scheduledEnabled?: number | null;
      }>()
    : null;
  const scheduledEnabled = scheduledEnabledColumnReady
    ? Number(statusRow?.scheduledEnabled ?? 0) === 1
    : isSymbolCatalogSyncEnabledFromEnv(env);

  const counts = lifecycleReady
    ? await env.DB.prepare(
      `SELECT
        COUNT(*) as totalCount,
        SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as activeCount,
        SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END) as inactiveCount,
        SUM(CASE WHEN COALESCE(listing_source, '') = 'manual' THEN 1 ELSE 0 END) as manualCount,
        SUM(CASE WHEN catalog_managed = 1 THEN 1 ELSE 0 END) as catalogManagedCount
      FROM symbols`,
    ).first<CatalogCountsRow>()
    : null;

  return {
    sourceKey: SYMBOL_CATALOG_SOURCE_KEY,
    scheduledEnabled,
    schemaReady: lifecycleReady && statusReady,
    lastSyncedAt: statusRow?.lastSyncedAt ?? null,
    status: statusRow?.status ?? null,
    error: statusRow?.error ?? null,
    recordsCount: statusRow?.recordsCount ?? null,
    updatedAt: statusRow?.updatedAt ?? null,
    totalCount: Number(counts?.totalCount ?? 0),
    activeCount: Number(counts?.activeCount ?? 0),
    inactiveCount: Number(counts?.inactiveCount ?? 0),
    manualCount: Number(counts?.manualCount ?? 0),
    catalogManagedCount: Number(counts?.catalogManagedCount ?? 0),
  };
}

export async function syncSymbolCatalogFromNasdaqTrader(
  env: Env,
  options: { trigger?: "manual" | "scheduled" } = {},
): Promise<SymbolCatalogSyncResult> {
  await requireSymbolDirectorySchema(env);
  const trigger = options.trigger ?? "manual";
  await markCatalogSyncRunning(env);

  try {
    const completedAt = new Date().toISOString();
    const rows = await loadNasdaqTraderCommonStocks();
    const existingState = await loadExistingSymbolStateMap(env, rows.map((row) => row.symbol));
    let inserted = 0;
    let updated = 0;
    let reactivated = 0;

    for (const row of rows) {
      const current = existingState.get(normalizeTicker(row.symbol));
      if (!current) {
        inserted += 1;
      } else {
        updated += 1;
        if (Number(current.isActive ?? 1) === 0) reactivated += 1;
      }
    }

    const statements = rows.map((row) => toCatalogUpsertStatement(env, row, completedAt));
    await runStatementsInChunks(env, statements);

    const deactivateResult = await env.DB.prepare(
      `UPDATE symbols
       SET
         is_active = 0,
         deactivated_at = ?,
         updated_at = CURRENT_TIMESTAMP
       WHERE catalog_managed = 1
         AND is_active = 1
         AND COALESCE(listing_source, '') <> 'manual'
         AND (catalog_last_seen_at IS NULL OR catalog_last_seen_at < ?)`,
    )
      .bind(completedAt, completedAt)
      .run();

    await markCatalogSyncSuccess(env, completedAt, rows.length);
    return {
      sourceKey: SYMBOL_CATALOG_SOURCE_KEY,
      trigger,
      fetched: rows.length,
      inserted,
      updated,
      reactivated,
      deactivated: Number(deactivateResult.meta?.changes ?? 0),
      completedAt,
      status: "ok",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Symbol catalog sync failed.";
    await markCatalogSyncError(env, message);
    throw error;
  }
}

export async function maybeRunScheduledSymbolCatalogSync(env: Env, now = new Date()): Promise<SymbolCatalogSyncResult | null> {
  if (!(await isSymbolCatalogSyncEnabled(env))) return null;
  const status = await loadSymbolCatalogStatus(env);
  if (!status.schemaReady || !isSymbolCatalogSyncDue(status.lastSyncedAt, now)) return null;
  return await syncSymbolCatalogFromNasdaqTrader(env, { trigger: "scheduled" });
}
