import type { Env } from "./types";
import { defaultScanProviders, normalizeScanSourceType } from "./scanning-providers";
import type {
  ScanCandidate,
  ScanCompiledRow,
  ScanDefinitionInput,
  ScanDefinitionRow,
  ScanFetchInput,
  ScanProviderTrace,
  ScanRunSummary,
  ScanSourceType,
  ScanStatus,
  ScanUniqueTickerRow,
} from "./scanning-types";

const DEFAULT_RETENTION_DAYS = 1;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function simpleHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalizeTicker(raw: string | null | undefined): string | null {
  const value = String(raw ?? "").trim().toUpperCase();
  if (!value) return null;
  const stripped = value.includes(":") ? value.split(":").pop() ?? value : value;
  const clean = stripped.replace(/[^A-Z0-9.\-^]/g, "");
  if (!clean || !/^[A-Z0-9.\-^]{1,20}$/.test(clean)) return null;
  return clean;
}

function toJson(value: unknown): string | null {
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function safeText(value: unknown, max = 1000): string | null {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

function normalizeCandidate(candidate: ScanCandidate): (ScanCandidate & { ticker: string; canonicalKey: string }) | null {
  const ticker = normalizeTicker(candidate.ticker);
  if (!ticker) return null;
  const providerRowKey = safeText(candidate.providerRowKey, 200) ?? "";
  const name = safeText(candidate.displayName, 240) ?? "";
  const rank = typeof candidate.rankValue === "number" && Number.isFinite(candidate.rankValue) ? candidate.rankValue : "";
  const canonicalKey = `${ticker}|${simpleHash(`${providerRowKey}|${name}|${rank}|${toJson(candidate.raw) ?? ""}`)}`;
  return {
    ...candidate,
    ticker,
    canonicalKey,
  };
}

function compileUniqueTickers(rows: ScanCompiledRow[]): ScanUniqueTickerRow[] {
  const byTicker = new Map<string, ScanUniqueTickerRow>();
  for (const row of rows) {
    const current = byTicker.get(row.ticker);
    if (!current) {
      byTicker.set(row.ticker, {
        ticker: row.ticker,
        displayName: row.displayName,
        occurrences: 1,
        latestRankValue: row.rankValue,
        latestRankLabel: row.rankLabel,
        latestPrice: row.price,
        latestChange1d: row.change1d,
      });
      continue;
    }
    current.occurrences += 1;
    if (!current.displayName && row.displayName) current.displayName = row.displayName;
    if (current.latestRankValue == null && row.rankValue != null) current.latestRankValue = row.rankValue;
    if (current.latestRankLabel == null && row.rankLabel != null) current.latestRankLabel = row.rankLabel;
    if (current.latestPrice == null && row.price != null) current.latestPrice = row.price;
    if (current.latestChange1d == null && row.change1d != null) current.latestChange1d = row.change1d;
  }
  return Array.from(byTicker.values()).sort((a, b) => a.ticker.localeCompare(b.ticker));
}

function csvEscape(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

export function compiledRowsToCsv(rows: ScanCompiledRow[]): string {
  const header = [
    "ticker",
    "display_name",
    "exchange",
    "provider_row_key",
    "rank_value",
    "rank_label",
    "price",
    "change_1d",
    "volume",
    "market_cap",
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push([
      row.ticker,
      row.displayName ?? "",
      row.exchange ?? "",
      row.providerRowKey ?? "",
      row.rankValue ?? "",
      row.rankLabel ?? "",
      row.price ?? "",
      row.change1d ?? "",
      row.volume ?? "",
      row.marketCap ?? "",
    ].map(csvEscape).join(","));
  }
  return lines.join("\n");
}

export function uniqueTickersToCsv(rows: ScanUniqueTickerRow[]): string {
  const lines = [["ticker", "display_name", "occurrences", "latest_rank_value", "latest_rank_label", "latest_price", "latest_change_1d"].join(",")];
  for (const row of rows) {
    lines.push([
      row.ticker,
      row.displayName ?? "",
      row.occurrences,
      row.latestRankValue ?? "",
      row.latestRankLabel ?? "",
      row.latestPrice ?? "",
      row.latestChange1d ?? "",
    ].map(csvEscape).join(","));
  }
  return lines.join("\n");
}

function normalizeInput(input: ScanDefinitionInput): ScanDefinitionInput {
  const providerKey = String(input.providerKey ?? "").trim().toLowerCase();
  const sourceType = normalizeScanSourceType(input.sourceType) as ScanSourceType | null;
  if (!providerKey) throw new Error("providerKey is required.");
  if (!sourceType) throw new Error("sourceType is invalid.");
  const sourceValue = String(input.sourceValue ?? "").trim();
  if (!sourceValue) throw new Error("sourceValue is required.");
  const fallbackSourceType = input.fallbackSourceType ? normalizeScanSourceType(input.fallbackSourceType) : null;
  const fallbackSourceValue = String(input.fallbackSourceValue ?? "").trim() || null;
  if ((fallbackSourceType && !fallbackSourceValue) || (!fallbackSourceType && fallbackSourceValue)) {
    throw new Error("fallback source type and value must be provided together.");
  }
  return {
    name: String(input.name ?? "").trim() || "Untitled Scan",
    providerKey,
    sourceType,
    sourceValue,
    fallbackSourceType,
    fallbackSourceValue,
    isActive: input.isActive !== false,
    notes: safeText(input.notes, 1000),
  };
}

function providerForInput(input: ScanFetchInput) {
  const provider = defaultScanProviders()
    .sort((a, b) => b.priority - a.priority)
    .find((candidate) => candidate.name === input.providerKey && candidate.canHandle(input));
  if (!provider) throw new Error(`No scan provider matched '${input.providerKey}' for source type '${input.sourceType}'.`);
  return provider;
}

async function runProvider(input: ScanFetchInput): Promise<{ rows: ScanCandidate[]; trace: ScanProviderTrace }> {
  const provider = providerForInput(input);
  const startedAt = Date.now();
  try {
    const rows = await provider.fetch(input);
    const acceptedCount = rows.map(normalizeCandidate).filter(Boolean).length;
    return {
      rows,
      trace: {
        provider: provider.name,
        status: acceptedCount > 0 ? "ok" : "empty",
        rawCount: rows.length,
        acceptedCount,
        durationMs: Date.now() - startedAt,
      },
    };
  } catch (error) {
    return {
      rows: [],
      trace: {
        provider: provider.name,
        status: "error",
        rawCount: 0,
        acceptedCount: 0,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message.slice(0, 180) : "provider failed",
      },
    };
  }
}

async function latestRunMap(env: Env): Promise<Map<string, ScanRunSummary>> {
  const rows = await env.DB.prepare(
    "SELECT r.id, r.scan_id as scanId, r.provider_key as providerKey, r.status, r.source_type as sourceType, r.source_value as sourceValue, r.fallback_used as fallbackUsed, r.raw_result_count as rawResultCount, r.compiled_row_count as compiledRowCount, r.unique_ticker_count as uniqueTickerCount, r.error, r.provider_trace_json as providerTraceJson, r.ingested_at as ingestedAt FROM scan_runs r JOIN (SELECT scan_id, MAX(datetime(ingested_at)) as latestIngestedAt FROM scan_runs GROUP BY scan_id) latest ON latest.scan_id = r.scan_id AND datetime(latest.latestIngestedAt) = datetime(r.ingested_at)",
  ).all<any>();
  const map = new Map<string, ScanRunSummary>();
  for (const row of rows.results ?? []) {
    map.set(row.scanId, {
      ...row,
      fallbackUsed: Boolean(row.fallbackUsed),
    });
  }
  return map;
}

export async function listScanDefinitions(env: Env): Promise<ScanDefinitionRow[]> {
  const latestByScan = await latestRunMap(env);
  const rows = await env.DB.prepare(
    "SELECT id, name, provider_key as providerKey, source_type as sourceType, source_value as sourceValue, fallback_source_type as fallbackSourceType, fallback_source_value as fallbackSourceValue, is_active as isActive, notes, created_at as createdAt, updated_at as updatedAt FROM scan_definitions WHERE provider_key <> 'watchlist-compiler' ORDER BY updated_at DESC, created_at DESC",
  ).all<any>();
  return (rows.results ?? []).map((row) => ({
    ...row,
    isActive: Boolean(row.isActive),
    latestRun: latestByScan.get(row.id) ?? null,
  }));
}

export async function upsertScanDefinition(env: Env, rawInput: ScanDefinitionInput & { id?: string | null }): Promise<{ id: string }> {
  const input = normalizeInput(rawInput);
  const existingId = String(rawInput.id ?? "").trim();
  const id = existingId || crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO scan_definitions (id, name, provider_key, source_type, source_value, fallback_source_type, fallback_source_value, is_active, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET name = excluded.name, provider_key = excluded.provider_key, source_type = excluded.source_type, source_value = excluded.source_value, fallback_source_type = excluded.fallback_source_type, fallback_source_value = excluded.fallback_source_value, is_active = excluded.is_active, notes = excluded.notes, updated_at = CURRENT_TIMESTAMP",
  )
    .bind(
      id,
      input.name,
      input.providerKey,
      input.sourceType,
      input.sourceValue,
      input.fallbackSourceType,
      input.fallbackSourceValue,
      input.isActive ? 1 : 0,
      input.notes,
    )
    .run();
  return { id };
}

export async function getScanDefinition(env: Env, scanId: string): Promise<ScanDefinitionRow | null> {
  const rows = await listScanDefinitions(env);
  return rows.find((row) => row.id === scanId) ?? null;
}

export async function ingestScan(env: Env, scanId: string): Promise<ScanRunSummary> {
  const definition = await getScanDefinition(env, scanId);
  if (!definition) throw new Error("Scan definition not found.");
  const trace: ScanProviderTrace[] = [];
  const primary = await runProvider({
    providerKey: definition.providerKey,
    sourceType: definition.sourceType,
    sourceValue: definition.sourceValue,
  });
  trace.push(primary.trace);

  let normalizedRows = primary.rows.map(normalizeCandidate).filter((row): row is ScanCandidate & { ticker: string; canonicalKey: string } => Boolean(row));
  let fallbackUsed = false;
  if (normalizedRows.length === 0 && definition.fallbackSourceType && definition.fallbackSourceValue) {
    const fallbackProviderKey = definition.fallbackSourceType;
    const fallback = await runProvider({
      providerKey: fallbackProviderKey,
      sourceType: definition.fallbackSourceType,
      sourceValue: definition.fallbackSourceValue,
    });
    trace.push(fallback.trace);
    normalizedRows = fallback.rows.map(normalizeCandidate).filter((row): row is ScanCandidate & { ticker: string; canonicalKey: string } => Boolean(row));
    fallbackUsed = normalizedRows.length > 0 || fallback.trace.status !== "skipped";
  }

  const dedupedRows = Array.from(new Map(normalizedRows.map((row) => [row.canonicalKey, row])).values());
  const status: ScanStatus = dedupedRows.length > 0 ? "ok" : trace.some((row) => row.status === "error") ? "error" : "empty";
  const error = status === "error"
    ? trace.filter((row) => row.error).map((row) => `${row.provider}: ${row.error}`).join("; ").slice(0, 1000) || "Scan ingestion failed."
    : null;
  const runId = crypto.randomUUID();
  const ingestedAt = new Date().toISOString();
  const uniqueTickerCount = new Set(dedupedRows.map((row) => row.ticker)).size;

  const statements = [
    env.DB.prepare(
      "INSERT INTO scan_runs (id, scan_id, provider_key, status, source_type, source_value, fallback_used, raw_result_count, compiled_row_count, unique_ticker_count, error, provider_trace_json, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      runId,
      scanId,
      definition.providerKey,
      status,
      definition.sourceType,
      definition.sourceValue,
      fallbackUsed ? 1 : 0,
      normalizedRows.length,
      dedupedRows.length,
      uniqueTickerCount,
      error,
      JSON.stringify(trace),
      ingestedAt,
    ),
    ...dedupedRows.map((row) =>
      env.DB.prepare(
        "INSERT OR IGNORE INTO scan_run_rows (id, run_id, scan_id, ticker, display_name, exchange, provider_row_key, rank_value, rank_label, price, change_1d, volume, market_cap, raw_json, canonical_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        crypto.randomUUID(),
        runId,
        scanId,
        row.ticker,
        safeText(row.displayName, 240),
        safeText(row.exchange, 80),
        safeText(row.providerRowKey, 200),
        typeof row.rankValue === "number" && Number.isFinite(row.rankValue) ? row.rankValue : null,
        safeText(row.rankLabel, 120),
        typeof row.price === "number" && Number.isFinite(row.price) ? row.price : null,
        typeof row.change1d === "number" && Number.isFinite(row.change1d) ? row.change1d : null,
        typeof row.volume === "number" && Number.isFinite(row.volume) ? row.volume : null,
        typeof row.marketCap === "number" && Number.isFinite(row.marketCap) ? row.marketCap : null,
        toJson(row.raw),
        row.canonicalKey,
        ingestedAt,
      ),
    ),
  ];
  await env.DB.batch(statements);
  await cleanupOldScanningData(env, DEFAULT_RETENTION_DAYS);
  return {
    id: runId,
    scanId,
    providerKey: definition.providerKey,
    status,
    sourceType: definition.sourceType,
    sourceValue: definition.sourceValue,
    fallbackUsed,
    rawResultCount: normalizedRows.length,
    compiledRowCount: dedupedRows.length,
    uniqueTickerCount,
    error,
    providerTraceJson: JSON.stringify(trace),
    ingestedAt,
  };
}

export async function listScanRuns(env: Env, scanId: string, limit = 25): Promise<ScanRunSummary[]> {
  const rows = await env.DB.prepare(
    "SELECT id, scan_id as scanId, provider_key as providerKey, status, source_type as sourceType, source_value as sourceValue, fallback_used as fallbackUsed, raw_result_count as rawResultCount, compiled_row_count as compiledRowCount, unique_ticker_count as uniqueTickerCount, error, provider_trace_json as providerTraceJson, ingested_at as ingestedAt FROM scan_runs WHERE scan_id = ? ORDER BY datetime(ingested_at) DESC LIMIT ?",
  ).bind(scanId, clamp(limit, 1, 100)).all<any>();
  return (rows.results ?? []).map((row) => ({ ...row, fallbackUsed: Boolean(row.fallbackUsed) }));
}

export async function loadRunCompiledRows(env: Env, scanId: string, runId: string): Promise<ScanCompiledRow[]> {
  const rows = await env.DB.prepare(
    "SELECT id, run_id as runId, scan_id as scanId, ticker, display_name as displayName, exchange, provider_row_key as providerRowKey, rank_value as rankValue, rank_label as rankLabel, price, change_1d as change1d, volume, market_cap as marketCap, raw_json as rawJson, canonical_key as canonicalKey, created_at as createdAt FROM scan_run_rows WHERE scan_id = ? AND run_id = ? ORDER BY ticker ASC, rank_value DESC, created_at DESC",
  ).bind(scanId, runId).all<ScanCompiledRow>();
  return rows.results ?? [];
}

export async function loadRunUniqueTickers(env: Env, scanId: string, runId: string): Promise<ScanUniqueTickerRow[]> {
  return compileUniqueTickers(await loadRunCompiledRows(env, scanId, runId));
}

export async function loadScanCompiledRows(env: Env, scanId: string): Promise<ScanCompiledRow[]> {
  const rows = await env.DB.prepare(
    "SELECT id, run_id as runId, scan_id as scanId, ticker, display_name as displayName, exchange, provider_row_key as providerRowKey, rank_value as rankValue, rank_label as rankLabel, price, change_1d as change1d, volume, market_cap as marketCap, raw_json as rawJson, canonical_key as canonicalKey, created_at as createdAt FROM scan_run_rows WHERE scan_id = ? ORDER BY datetime(created_at) DESC, ticker ASC",
  ).bind(scanId).all<ScanCompiledRow>();
  return rows.results ?? [];
}

export async function loadScanUniqueTickers(env: Env, scanId: string): Promise<ScanUniqueTickerRow[]> {
  return compileUniqueTickers(await loadScanCompiledRows(env, scanId));
}

export async function cleanupOldScanningData(env: Env, retentionDays = DEFAULT_RETENTION_DAYS): Promise<{ deletedRuns: number; deletedRows: number }> {
  const window = `-${Math.max(1, retentionDays)} day`;
  const deleteRows = await env.DB.prepare(
    "DELETE FROM scan_run_rows WHERE datetime(created_at) < datetime('now', ?)",
  ).bind(window).run();
  const deleteRuns = await env.DB.prepare(
    "DELETE FROM scan_runs WHERE datetime(ingested_at) < datetime('now', ?)",
  ).bind(window).run();
  return {
    deletedRuns: deleteRuns.meta?.changes ?? 0,
    deletedRows: deleteRows.meta?.changes ?? 0,
  };
}

export async function refreshActiveScans(env: Env): Promise<{ refreshedScans: number; refreshedRows: number }> {
  const rows = await env.DB.prepare(
    "SELECT id FROM scan_definitions WHERE is_active = 1 ORDER BY updated_at DESC",
  ).all<{ id: string }>();
  let refreshedRows = 0;
  let refreshedScans = 0;
  for (const row of rows.results ?? []) {
    const result = await ingestScan(env, row.id);
    refreshedScans += 1;
    refreshedRows += result.compiledRowCount;
  }
  return { refreshedScans, refreshedRows };
}
