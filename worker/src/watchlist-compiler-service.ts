import { TradingViewPublicLinkProvider } from "./scanning-providers";
import { loadRunCompiledRows, loadRunUniqueTickers } from "./scanning-service";
import type { ScanCompiledRow, ScanRunSummary, ScanUniqueTickerRow } from "./scanning-types";
import type { Env } from "./types";

const INTERNAL_PROVIDER_KEY = "watchlist-compiler";
const DEFAULT_COMPILE_TIME = "08:15";
const DEFAULT_COMPILE_TIMEZONE = "Australia/Sydney";

export type WatchlistSetRecord = {
  id: string;
  scanDefinitionId: string;
  name: string;
  slug: string;
  isActive: boolean;
  compileDaily: boolean;
  dailyCompileTimeLocal: string | null;
  dailyCompileTimezone: string | null;
  createdAt: string;
  updatedAt: string;
  sourceCount: number;
  latestRun: ScanRunSummary | null;
};

export type WatchlistSourceRecord = {
  id: string;
  setId: string;
  sourceName: string | null;
  sourceUrl: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type WatchlistSetDetail = WatchlistSetRecord & {
  sources: WatchlistSourceRecord[];
};

type WatchlistCandidate = {
  ticker: string;
  displayName: string | null;
  exchange: string | null;
  providerRowKey: string | null;
  rankValue: number | null;
  rankLabel: string | null;
  price: number | null;
  change1d: number | null;
  volume: number | null;
  marketCap: number | null;
  raw: unknown;
  canonicalKey: string;
};

type WatchlistCompileTrace = {
  sourceId: string;
  sourceUrl: string;
  status: "ok" | "empty" | "error";
  rawCount: number;
  acceptedCount: number;
  durationMs: number;
  error?: string;
};

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

function csvEscape(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

function normalizeTicker(raw: string | null | undefined): string | null {
  const value = String(raw ?? "").trim().toUpperCase();
  if (!value) return null;
  const stripped = value.includes(":") ? value.split(":").pop() ?? value : value;
  const clean = stripped.replace(/[^A-Z0-9.\-^]/g, "");
  if (!clean || !/^[A-Z0-9.\-^]{1,20}$/.test(clean)) return null;
  return clean;
}

function safeText(value: unknown, max = 1000): string | null {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

function toJson(value: unknown): string | null {
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "watchlist-set";
}

function normalizeCandidate(input: {
  sourceId: string;
  sourceUrl: string;
  candidate: {
    ticker: string;
    displayName?: string | null;
    exchange?: string | null;
    providerRowKey?: string | null;
    rankValue?: number | null;
    rankLabel?: string | null;
    price?: number | null;
    change1d?: number | null;
    volume?: number | null;
    marketCap?: number | null;
    raw: unknown;
  };
}): WatchlistCandidate | null {
  const ticker = normalizeTicker(input.candidate.ticker);
  if (!ticker) return null;
  const displayName = safeText(input.candidate.displayName, 240);
  const providerRowKey = safeText(input.candidate.providerRowKey, 200) ?? `${input.sourceId}:${ticker}`;
  const exchange = safeText(input.candidate.exchange, 80);
  const raw = {
    sourceId: input.sourceId,
    sourceUrl: input.sourceUrl,
    row: input.candidate.raw,
  };
  const canonicalKey = `${ticker}|${simpleHash(`${input.sourceId}|${providerRowKey}|${displayName ?? ""}|${toJson(raw) ?? ""}`)}`;
  return {
    ticker,
    displayName,
    exchange,
    providerRowKey,
    rankValue: typeof input.candidate.rankValue === "number" && Number.isFinite(input.candidate.rankValue) ? input.candidate.rankValue : null,
    rankLabel: safeText(input.candidate.rankLabel, 120),
    price: typeof input.candidate.price === "number" && Number.isFinite(input.candidate.price) ? input.candidate.price : null,
    change1d: typeof input.candidate.change1d === "number" && Number.isFinite(input.candidate.change1d) ? input.candidate.change1d : null,
    volume: typeof input.candidate.volume === "number" && Number.isFinite(input.candidate.volume) ? input.candidate.volume : null,
    marketCap: typeof input.candidate.marketCap === "number" && Number.isFinite(input.candidate.marketCap) ? input.candidate.marketCap : null,
    raw,
    canonicalKey,
  };
}

function mapRunSummary(row: any): ScanRunSummary {
  return {
    ...row,
    fallbackUsed: Boolean(row.fallbackUsed),
  };
}

function localDateString(value = new Date()): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function zonedLocalDate(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function zonedMinutesOfDay(now: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

function parseLocalTime(value: string | null | undefined): { hour: number; minute: number } | null {
  if (!value) return null;
  const match = value.trim().match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

export function tickersToTxt(tickers: string[]): string {
  return tickers.join("\n");
}

export function tickersToSingleColumnCsv(tickers: string[]): string {
  return ["ticker", ...tickers.map((ticker) => csvEscape(ticker))].join("\n");
}

export function shouldRunScheduledWatchlistCompile(input: {
  compileDaily: boolean;
  dailyCompileTimeLocal: string | null;
  dailyCompileTimezone: string | null;
  latestRunIngestedAt: string | null;
  now: Date;
}): boolean {
  if (!input.compileDaily) return false;
  const timezone = input.dailyCompileTimezone || DEFAULT_COMPILE_TIMEZONE;
  const target = parseLocalTime(input.dailyCompileTimeLocal || DEFAULT_COMPILE_TIME) ?? parseLocalTime(DEFAULT_COMPILE_TIME)!;
  const targetMinutes = target.hour * 60 + target.minute;
  const minutesOfDay = zonedMinutesOfDay(input.now, timezone);
  if (minutesOfDay < targetMinutes || minutesOfDay >= targetMinutes + 15) return false;
  const todayLocal = zonedLocalDate(input.now, timezone);
  if (!input.latestRunIngestedAt) return true;
  return zonedLocalDate(new Date(input.latestRunIngestedAt), timezone) !== todayLocal;
}

async function latestRunMap(env: Env): Promise<Map<string, ScanRunSummary>> {
  const rows = await env.DB.prepare(
    "SELECT r.id, r.scan_id as scanId, r.provider_key as providerKey, r.status, r.source_type as sourceType, r.source_value as sourceValue, r.fallback_used as fallbackUsed, r.raw_result_count as rawResultCount, r.compiled_row_count as compiledRowCount, r.unique_ticker_count as uniqueTickerCount, r.error, r.provider_trace_json as providerTraceJson, r.ingested_at as ingestedAt FROM scan_runs r JOIN (SELECT scan_id, MAX(datetime(ingested_at)) as latestIngestedAt FROM scan_runs GROUP BY scan_id) latest ON latest.scan_id = r.scan_id AND datetime(latest.latestIngestedAt) = datetime(r.ingested_at)",
  ).all<any>();
  const map = new Map<string, ScanRunSummary>();
  for (const row of rows.results ?? []) map.set(row.scanId, mapRunSummary(row));
  return map;
}

export async function listWatchlistSets(env: Env, includeInactive = false): Promise<WatchlistSetRecord[]> {
  const latestByScan = await latestRunMap(env);
  const rows = await env.DB.prepare(
    `SELECT
      s.id,
      s.scan_definition_id as scanDefinitionId,
      s.name,
      s.slug,
      s.is_active as isActive,
      s.compile_daily as compileDaily,
      s.daily_compile_time_local as dailyCompileTimeLocal,
      s.daily_compile_timezone as dailyCompileTimezone,
      s.created_at as createdAt,
      s.updated_at as updatedAt,
      (SELECT COUNT(*) FROM tv_watchlist_sources src WHERE src.set_id = s.id AND src.is_active = 1) as sourceCount
    FROM tv_watchlist_sets s
    ${includeInactive ? "" : "WHERE s.is_active = 1"}
    ORDER BY s.updated_at DESC, s.created_at DESC`,
  ).all<any>();
  return (rows.results ?? []).map((row) => ({
    ...row,
    isActive: Boolean(row.isActive),
    compileDaily: Boolean(row.compileDaily),
    sourceCount: Number(row.sourceCount ?? 0),
    latestRun: latestByScan.get(row.scanDefinitionId) ?? null,
  }));
}

export async function listWatchlistSources(env: Env, setId: string): Promise<WatchlistSourceRecord[]> {
  const rows = await env.DB.prepare(
    "SELECT id, set_id as setId, source_name as sourceName, source_url as sourceUrl, sort_order as sortOrder, is_active as isActive, created_at as createdAt, updated_at as updatedAt FROM tv_watchlist_sources WHERE set_id = ? ORDER BY sort_order ASC, created_at ASC",
  ).bind(setId).all<any>();
  return (rows.results ?? []).map((row) => ({ ...row, isActive: Boolean(row.isActive) }));
}

export async function loadWatchlistSet(env: Env, setId: string): Promise<WatchlistSetDetail | null> {
  const set = (await listWatchlistSets(env, true)).find((row) => row.id === setId) ?? null;
  if (!set) return null;
  const sources = await listWatchlistSources(env, setId);
  return { ...set, sources };
}

export async function listWatchlistSetRuns(env: Env, setId: string, limit = 25): Promise<ScanRunSummary[]> {
  const detail = await loadWatchlistSet(env, setId);
  if (!detail) return [];
  const rows = await env.DB.prepare(
    "SELECT id, scan_id as scanId, provider_key as providerKey, status, source_type as sourceType, source_value as sourceValue, fallback_used as fallbackUsed, raw_result_count as rawResultCount, compiled_row_count as compiledRowCount, unique_ticker_count as uniqueTickerCount, error, provider_trace_json as providerTraceJson, ingested_at as ingestedAt FROM scan_runs WHERE scan_id = ? ORDER BY datetime(ingested_at) DESC LIMIT ?",
  ).bind(detail.scanDefinitionId, clamp(limit, 1, 100)).all<any>();
  return (rows.results ?? []).map(mapRunSummary);
}

export async function resolveWatchlistRunId(env: Env, setId: string, runId?: string | null): Promise<{ set: WatchlistSetDetail; runId: string | null }> {
  const set = await loadWatchlistSet(env, setId);
  if (!set) throw new Error("Watchlist set not found.");
  if (runId) return { set, runId };
  return { set, runId: set.latestRun?.id ?? null };
}

export async function loadWatchlistCompiledRows(env: Env, setId: string, runId?: string | null): Promise<{ set: WatchlistSetDetail; runId: string | null; rows: ScanCompiledRow[] }> {
  const resolved = await resolveWatchlistRunId(env, setId, runId);
  if (!resolved.runId) return { ...resolved, rows: [] };
  return {
    ...resolved,
    rows: await loadRunCompiledRows(env, resolved.set.scanDefinitionId, resolved.runId),
  };
}

export async function loadWatchlistUniqueRows(env: Env, setId: string, runId?: string | null): Promise<{ set: WatchlistSetDetail; runId: string | null; rows: ScanUniqueTickerRow[] }> {
  const resolved = await resolveWatchlistRunId(env, setId, runId);
  if (!resolved.runId) return { ...resolved, rows: [] };
  return {
    ...resolved,
    rows: await loadRunUniqueTickers(env, resolved.set.scanDefinitionId, resolved.runId),
  };
}

export async function createWatchlistSet(env: Env, input: {
  name: string;
  slug?: string | null;
  isActive?: boolean;
  compileDaily?: boolean;
  dailyCompileTimeLocal?: string | null;
  dailyCompileTimezone?: string | null;
}): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  const scanDefinitionId = crypto.randomUUID();
  const slug = slugify(input.slug?.trim() || input.name);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO scan_definitions (id, name, provider_key, source_type, source_value, fallback_source_type, fallback_source_value, is_active, notes, created_at, updated_at) VALUES (?, ?, ?, 'tradingview-public-link', ?, NULL, NULL, 0, 'internal:watchlist-compiler', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
    ).bind(scanDefinitionId, input.name.trim(), INTERNAL_PROVIDER_KEY, `watchlist-set:${slug}`),
    env.DB.prepare(
      "INSERT INTO tv_watchlist_sets (id, scan_definition_id, name, slug, is_active, compile_daily, daily_compile_time_local, daily_compile_timezone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
    ).bind(
      id,
      scanDefinitionId,
      input.name.trim(),
      slug,
      input.isActive === false ? 0 : 1,
      input.compileDaily ? 1 : 0,
      input.dailyCompileTimeLocal?.trim() || null,
      input.dailyCompileTimezone?.trim() || null,
    ),
  ]);
  return { id };
}

export async function updateWatchlistSet(env: Env, setId: string, input: {
  name?: string;
  slug?: string | null;
  isActive?: boolean;
  compileDaily?: boolean;
  dailyCompileTimeLocal?: string | null;
  dailyCompileTimezone?: string | null;
}): Promise<void> {
  const existing = await loadWatchlistSet(env, setId);
  if (!existing) throw new Error("Watchlist set not found.");
  const name = input.name?.trim() || existing.name;
  const slug = slugify(input.slug?.trim() || existing.slug || name);
  const isActive = input.isActive == null ? existing.isActive : input.isActive;
  const compileDaily = input.compileDaily == null ? existing.compileDaily : input.compileDaily;
  const dailyCompileTimeLocal = input.dailyCompileTimeLocal === undefined ? existing.dailyCompileTimeLocal : (input.dailyCompileTimeLocal?.trim() || null);
  const dailyCompileTimezone = input.dailyCompileTimezone === undefined ? existing.dailyCompileTimezone : (input.dailyCompileTimezone?.trim() || null);
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE tv_watchlist_sets SET name = ?, slug = ?, is_active = ?, compile_daily = ?, daily_compile_time_local = ?, daily_compile_timezone = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).bind(name, slug, isActive ? 1 : 0, compileDaily ? 1 : 0, dailyCompileTimeLocal, dailyCompileTimezone, setId),
    env.DB.prepare(
      "UPDATE scan_definitions SET name = ?, source_value = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).bind(name, `watchlist-set:${slug}`, existing.scanDefinitionId),
  ]);
}

export async function deleteWatchlistSet(env: Env, setId: string): Promise<void> {
  const existing = await loadWatchlistSet(env, setId);
  if (!existing) return;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM tv_watchlist_sources WHERE set_id = ?").bind(setId),
    env.DB.prepare("DELETE FROM scan_run_rows WHERE scan_id = ?").bind(existing.scanDefinitionId),
    env.DB.prepare("DELETE FROM scan_runs WHERE scan_id = ?").bind(existing.scanDefinitionId),
    env.DB.prepare("DELETE FROM tv_watchlist_sets WHERE id = ?").bind(setId),
    env.DB.prepare("DELETE FROM scan_definitions WHERE id = ?").bind(existing.scanDefinitionId),
  ]);
}

export async function createWatchlistSource(env: Env, setId: string, input: { sourceName?: string | null; sourceUrl: string; isActive?: boolean }): Promise<{ id: string }> {
  const set = await loadWatchlistSet(env, setId);
  if (!set) throw new Error("Watchlist set not found.");
  const id = crypto.randomUUID();
  const nextOrder = await env.DB.prepare(
    "SELECT COALESCE(MAX(sort_order), 0) + 1 as nextOrder FROM tv_watchlist_sources WHERE set_id = ?",
  ).bind(setId).first<{ nextOrder: number }>();
  await env.DB.prepare(
    "INSERT INTO tv_watchlist_sources (id, set_id, source_name, source_url, sort_order, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
  ).bind(id, setId, input.sourceName?.trim() || null, input.sourceUrl.trim(), nextOrder?.nextOrder ?? 1, input.isActive === false ? 0 : 1).run();
  await env.DB.prepare("UPDATE tv_watchlist_sets SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(setId).run();
  return { id };
}

export async function updateWatchlistSource(env: Env, sourceId: string, input: { sourceName?: string | null; sourceUrl?: string; sortOrder?: number; isActive?: boolean }): Promise<void> {
  const existing = await env.DB.prepare(
    "SELECT id, set_id as setId, source_name as sourceName, source_url as sourceUrl, sort_order as sortOrder, is_active as isActive FROM tv_watchlist_sources WHERE id = ? LIMIT 1",
  ).bind(sourceId).first<{ id: string; setId: string; sourceName: string | null; sourceUrl: string; sortOrder: number; isActive: number }>();
  if (!existing) throw new Error("Watchlist source not found.");
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE tv_watchlist_sources SET source_name = ?, source_url = ?, sort_order = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).bind(
      input.sourceName === undefined ? existing.sourceName : (input.sourceName?.trim() || null),
      input.sourceUrl?.trim() || existing.sourceUrl,
      input.sortOrder == null ? existing.sortOrder : input.sortOrder,
      input.isActive == null ? existing.isActive : (input.isActive ? 1 : 0),
      sourceId,
    ),
    env.DB.prepare("UPDATE tv_watchlist_sets SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(existing.setId),
  ]);
}

export async function deleteWatchlistSource(env: Env, sourceId: string): Promise<void> {
  const existing = await env.DB.prepare(
    "SELECT set_id as setId FROM tv_watchlist_sources WHERE id = ? LIMIT 1",
  ).bind(sourceId).first<{ setId: string }>();
  if (!existing) return;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM tv_watchlist_sources WHERE id = ?").bind(sourceId),
    env.DB.prepare("UPDATE tv_watchlist_sets SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(existing.setId),
  ]);
}

export async function compileWatchlistSet(env: Env, setId: string): Promise<{ run: ScanRunSummary; set: WatchlistSetDetail }> {
  const set = await loadWatchlistSet(env, setId);
  if (!set) throw new Error("Watchlist set not found.");
  const activeSources = set.sources.filter((source) => source.isActive);
  if (activeSources.length === 0) throw new Error("Add at least one active TradingView watchlist URL first.");

  const provider = new TradingViewPublicLinkProvider();
  const traces: WatchlistCompileTrace[] = [];
  const normalizedRows: WatchlistCandidate[] = [];

  for (const source of activeSources) {
    const startedAt = Date.now();
    try {
      const candidates = await provider.fetch({
        providerKey: "tradingview-public-link",
        sourceType: "tradingview-public-link",
        sourceValue: source.sourceUrl,
      });
      const accepted = candidates
        .map((candidate) => normalizeCandidate({ sourceId: source.id, sourceUrl: source.sourceUrl, candidate }))
        .filter((candidate): candidate is WatchlistCandidate => Boolean(candidate));
      normalizedRows.push(...accepted);
      traces.push({
        sourceId: source.id,
        sourceUrl: source.sourceUrl,
        status: accepted.length > 0 ? "ok" : "empty",
        rawCount: candidates.length,
        acceptedCount: accepted.length,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      traces.push({
        sourceId: source.id,
        sourceUrl: source.sourceUrl,
        status: "error",
        rawCount: 0,
        acceptedCount: 0,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message.slice(0, 180) : "TradingView fetch failed.",
      });
    }
  }

  const dedupedRows = Array.from(new Map(normalizedRows.map((row) => [row.canonicalKey, row])).values());
  const status = dedupedRows.length > 0 ? "ok" : traces.some((trace) => trace.status === "error") ? "error" : "empty";
  const error = status === "error"
    ? traces.filter((trace) => trace.error).map((trace) => `${trace.sourceUrl}: ${trace.error}`).join("; ").slice(0, 1000) || "Watchlist compile failed."
    : null;
  const runId = crypto.randomUUID();
  const ingestedAt = new Date().toISOString();
  const uniqueTickerCount = new Set(dedupedRows.map((row) => row.ticker)).size;

  const statements = [
    env.DB.prepare(
      "INSERT INTO scan_runs (id, scan_id, provider_key, status, source_type, source_value, fallback_used, raw_result_count, compiled_row_count, unique_ticker_count, error, provider_trace_json, ingested_at) VALUES (?, ?, ?, ?, 'tradingview-public-link', ?, 0, ?, ?, ?, ?, ?, ?)",
    ).bind(
      runId,
      set.scanDefinitionId,
      INTERNAL_PROVIDER_KEY,
      status,
      `watchlist-set:${set.slug}`,
      normalizedRows.length,
      dedupedRows.length,
      uniqueTickerCount,
      error,
      JSON.stringify(traces),
      ingestedAt,
    ),
    ...dedupedRows.map((row) =>
      env.DB.prepare(
        "INSERT OR IGNORE INTO scan_run_rows (id, run_id, scan_id, ticker, display_name, exchange, provider_row_key, rank_value, rank_label, price, change_1d, volume, market_cap, raw_json, canonical_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        crypto.randomUUID(),
        runId,
        set.scanDefinitionId,
        row.ticker,
        row.displayName,
        row.exchange,
        row.providerRowKey,
        row.rankValue,
        row.rankLabel,
        row.price,
        row.change1d,
        row.volume,
        row.marketCap,
        toJson(row.raw),
        row.canonicalKey,
        ingestedAt,
      ),
    ),
  ];
  await env.DB.batch(statements);
  const run: ScanRunSummary = {
    id: runId,
    scanId: set.scanDefinitionId,
    providerKey: INTERNAL_PROVIDER_KEY,
    status,
    sourceType: "tradingview-public-link",
    sourceValue: `watchlist-set:${set.slug}`,
    fallbackUsed: false,
    rawResultCount: normalizedRows.length,
    compiledRowCount: dedupedRows.length,
    uniqueTickerCount,
    error,
    providerTraceJson: JSON.stringify(traces),
    ingestedAt,
  };
  return { run, set: { ...set, latestRun: run } };
}

export async function compileActiveWatchlistSets(env: Env): Promise<{ compiledSets: number; compiledRows: number }> {
  const sets = (await listWatchlistSets(env, false)).filter((set) => set.isActive);
  let compiledSets = 0;
  let compiledRows = 0;
  for (const set of sets) {
    const result = await compileWatchlistSet(env, set.id);
    compiledSets += 1;
    compiledRows += result.run.compiledRowCount;
  }
  return { compiledSets, compiledRows };
}

export async function runDueWatchlistCompiles(env: Env, now: Date): Promise<{ compiledSets: number }> {
  const sets = (await listWatchlistSets(env, false)).filter((set) => set.isActive && set.compileDaily);
  let compiledSets = 0;
  for (const set of sets) {
    if (!shouldRunScheduledWatchlistCompile({
      compileDaily: set.compileDaily,
      dailyCompileTimeLocal: set.dailyCompileTimeLocal,
      dailyCompileTimezone: set.dailyCompileTimezone,
      latestRunIngestedAt: set.latestRun?.ingestedAt ?? null,
      now,
    })) continue;
    await compileWatchlistSet(env, set.id);
    compiledSets += 1;
  }
  return { compiledSets };
}

export function resolveExportFileName(input: {
  slug: string;
  mode: "compiled" | "unique";
  extension: "csv" | "txt";
  dateSuffix?: string | null;
}): string {
  const dateSuffix = input.dateSuffix?.trim() || localDateString();
  return `${input.slug}-${dateSuffix}.${input.extension}`;
}
