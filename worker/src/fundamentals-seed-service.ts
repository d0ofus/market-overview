import type { Env } from "./types";
import {
  loadFundamentalIssuerMap,
  refreshTickerFundamentals,
  type FundamentalIssuer,
} from "./fundamentals-service";

const TV_SCAN_URL = "https://scanner.tradingview.com/america/scan";
const TV_PROVIDER_LABEL = "TradingView Screener (america/stocks market cap)";
const MARKET_CAP_COLUMNS = ["name", "market_cap_basic", "exchange", "type", "country"] as const;
const MAX_FETCH_RANGE = 1000;
const MAX_DISCOVERY_ROWS = 10_000;
const QUEUE_BATCH_SIZE = 50;
const PROCESS_LIMIT_MAX = 10;
const PROCESS_DELAY_MS = 250;

type FundamentalSeedStatus = "queued" | "running" | "ok" | "no_supported_rows" | "error" | "skipped";

type TradingViewScanPayload = {
  markets: string[];
  symbols: { query: { types: string[] }; tickers: string[] };
  options: { lang: string };
  columns: string[];
  sort: { sortBy: string; sortOrder: "asc" | "desc" };
  range: [number, number];
  filter: Array<{ left: string; operation: string; right: unknown }>;
};

type TradingViewMarketCapResponse = {
  totalCount?: number;
  data?: Array<{ s?: string; d?: unknown[] }>;
};

export type TradingViewMarketCapRow = {
  ticker: string;
  companyName: string | null;
  marketCap: number | null;
  exchange: string | null;
  type: string | null;
  country: string | null;
};

type SeedQueueCandidate = {
  ticker: string;
  cik: string;
  companyName: string;
  exchange: string | null;
  marketCap: number | null;
  priorityRank: number;
};

type SeedQueueRow = {
  ticker: string;
  cik: string;
  companyName: string;
  exchange: string | null;
  marketCap: number | null;
  priorityRank: number;
  status: FundamentalSeedStatus;
  attempts: number;
};

type QueueCountRow = {
  status: string;
  count: number;
};

type DbCountRow = {
  count: number;
};

function fundamentalsDb(env: Env): D1Database | null {
  return env.FUNDAMENTALS_DB ?? null;
}

function normalizeTicker(value: unknown): string {
  const raw = String(value ?? "").trim().toUpperCase();
  if (!raw) return "";
  const parts = raw.split(":");
  return parts[parts.length - 1]?.trim() ?? raw;
}

function normalizeText(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function normalizeNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeExchange(value: unknown): string | null {
  const text = normalizeText(value)?.toUpperCase() ?? null;
  if (!text) return null;
  if (text === "NYSE MKT" || text === "NYSE AMERICAN") return "AMEX";
  return text;
}

function normalizeCountry(value: unknown): string | null {
  const text = normalizeText(value);
  return text ? text.toUpperCase() : null;
}

function isAllowedUsCountry(value: string | null): boolean {
  if (!value) return true;
  return value === "UNITED STATES" || value === "UNITED STATES OF AMERICA" || value === "US" || value === "USA";
}

export function parseTradingViewMarketCapRows(body: TradingViewMarketCapResponse): TradingViewMarketCapRow[] {
  return (body.data ?? [])
    .map((entry) => {
      const data = Array.isArray(entry.d) ? entry.d : [];
      return {
        ticker: normalizeTicker(entry.s),
        companyName: normalizeText(data[0]),
        marketCap: normalizeNumber(data[1]),
        exchange: normalizeExchange(data[2]),
        type: normalizeText(data[3])?.toLowerCase() ?? null,
        country: normalizeCountry(data[4]),
      } satisfies TradingViewMarketCapRow;
    })
    .filter((row) => Boolean(row.ticker));
}

export function isEligibleTradingViewMarketCapRow(row: TradingViewMarketCapRow): boolean {
  if (!row.ticker || row.ticker.includes(".")) return false;
  if (row.marketCap == null || row.marketCap <= 0) return false;
  if (!row.exchange || !["NASDAQ", "NYSE", "AMEX"].includes(row.exchange)) return false;
  if (row.type && row.type !== "stock") return false;
  if (!isAllowedUsCountry(row.country)) return false;
  return true;
}

function buildTradingViewMarketCapPayload(rangeOffset: number, rangeLimit: number): TradingViewScanPayload {
  return {
    markets: ["america"],
    symbols: { query: { types: [] }, tickers: [] },
    options: { lang: "en" },
    columns: [...MARKET_CAP_COLUMNS],
    sort: { sortBy: "market_cap_basic", sortOrder: "desc" },
    range: [rangeOffset, rangeOffset + rangeLimit],
    filter: [
      { left: "market_cap_basic", operation: "greater", right: 0 },
    ],
  };
}

async function fetchTradingViewMarketCapRows(targetRows: number): Promise<{ rows: TradingViewMarketCapRow[]; fetchedRows: number }> {
  const discoveryRows = Math.max(
    Math.min(MAX_DISCOVERY_ROWS, Math.max(targetRows * 4, MAX_FETCH_RANGE)),
    targetRows,
  );
  const rows: TradingViewMarketCapRow[] = [];
  let targetFetchCount = discoveryRows;
  let fetchedRows = 0;

  for (let rangeOffset = 0; rangeOffset < targetFetchCount; rangeOffset += MAX_FETCH_RANGE) {
    const rangeLimit = Math.min(MAX_FETCH_RANGE, targetFetchCount - rangeOffset);
    const payload = buildTradingViewMarketCapPayload(rangeOffset, rangeLimit);
    const response = await fetch(TV_SCAN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "market-command-centre/1.0",
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`TradingView fundamentals seed request failed (${response.status}): ${body.slice(0, 180)}`);
    }
    const body = await response.json() as TradingViewMarketCapResponse;
    const pageRows = parseTradingViewMarketCapRows(body);
    rows.push(...pageRows);
    fetchedRows += pageRows.length;

    if (typeof body.totalCount === "number" && Number.isFinite(body.totalCount)) {
      targetFetchCount = Math.min(discoveryRows, body.totalCount);
    }
    if (pageRows.length === 0 || pageRows.length < rangeLimit) break;
  }

  return { rows, fetchedRows };
}

async function hasFundamentalSeedSchema(db: D1Database): Promise<boolean> {
  const row = await db.prepare(
    "SELECT COUNT(*) as count FROM sqlite_master WHERE type = 'table' AND name IN ('fundamental_seed_queue', 'fundamental_seed_runs')",
  ).first<DbCountRow>();
  return Number(row?.count ?? 0) >= 2;
}

async function requireFundamentalSeedSchema(env: Env): Promise<D1Database> {
  const db = fundamentalsDb(env);
  if (!db) throw new Error("FUNDAMENTALS_DB binding is not configured.");
  if (!(await hasFundamentalSeedSchema(db))) {
    throw new Error("Fundamentals seed schema is missing. Apply worker/fundamentals-migrations/0003_fundamentals_seed_queue.sql.");
  }
  return db;
}

async function runStatementsInChunks(db: D1Database, statements: D1PreparedStatement[], chunkSize = QUEUE_BATCH_SIZE): Promise<void> {
  for (let index = 0; index < statements.length; index += chunkSize) {
    const chunk = statements.slice(index, index + chunkSize);
    if (chunk.length > 0) await db.batch(chunk);
  }
}

async function loadSavedEquityUniverse(env: Env): Promise<Set<string>> {
  const rows = await env.DB.prepare(
    `SELECT ticker
     FROM symbols
     WHERE COALESCE(is_active, 1) = 1
       AND LOWER(COALESCE(asset_class, '')) IN ('equity', 'stock', 'us_equity')
       AND UPPER(COALESCE(exchange, '')) NOT LIKE '%OTC%'`,
  ).all<{ ticker: string }>();
  return new Set((rows.results ?? []).map((row) => normalizeTicker(row.ticker)).filter(Boolean));
}

function dedupeCandidates(rows: SeedQueueCandidate[]): SeedQueueCandidate[] {
  const byTicker = new Map<string, SeedQueueCandidate>();
  for (const row of rows) {
    if (!byTicker.has(row.ticker)) byTicker.set(row.ticker, row);
  }
  return Array.from(byTicker.values()).sort((left, right) => left.priorityRank - right.priorityRank);
}

function makeRunId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function recordSeedRun(
  db: D1Database,
  input: {
    id: string;
    runType: "build" | "process";
    trigger: "manual" | "scheduled";
    requestedLimit: number;
    startedAt: string;
    completedAt: string;
    fetchedRows?: number;
    eligibleRows?: number;
    queuedRows?: number;
    processedRows?: number;
    okRows?: number;
    errorRows?: number;
    noSupportedRows?: number;
    error?: string | null;
  },
): Promise<void> {
  await db.prepare(
    `INSERT INTO fundamental_seed_runs (
       id, run_type, trigger, requested_limit, fetched_rows, eligible_rows, queued_rows,
       processed_rows, ok_rows, error_rows, no_supported_rows, started_at, completed_at, error
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    input.id,
    input.runType,
    input.trigger,
    input.requestedLimit,
    input.fetchedRows ?? 0,
    input.eligibleRows ?? 0,
    input.queuedRows ?? 0,
    input.processedRows ?? 0,
    input.okRows ?? 0,
    input.errorRows ?? 0,
    input.noSupportedRows ?? 0,
    input.startedAt,
    input.completedAt,
    input.error ?? null,
  ).run();
}

function toQueueUpsert(db: D1Database, candidate: SeedQueueCandidate): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO fundamental_seed_queue (
       ticker, cik, company_name, exchange, market_cap, priority_rank, source, status,
       attempts, rows_upserted, last_error, next_attempt_at, created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, 'tradingview_market_cap', 'queued', 0, 0, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(ticker) DO UPDATE SET
       cik = excluded.cik,
       company_name = excluded.company_name,
       exchange = excluded.exchange,
       market_cap = excluded.market_cap,
       priority_rank = excluded.priority_rank,
       source = excluded.source,
       status = CASE
         WHEN fundamental_seed_queue.status IN ('ok', 'no_supported_rows', 'skipped', 'running') THEN fundamental_seed_queue.status
         ELSE 'queued'
       END,
       last_error = CASE
         WHEN fundamental_seed_queue.status IN ('ok', 'no_supported_rows', 'skipped', 'running') THEN fundamental_seed_queue.last_error
         ELSE NULL
       END,
       next_attempt_at = CASE
         WHEN fundamental_seed_queue.status IN ('ok', 'no_supported_rows', 'skipped', 'running') THEN fundamental_seed_queue.next_attempt_at
         ELSE NULL
       END,
       updated_at = CURRENT_TIMESTAMP`,
  ).bind(
    candidate.ticker,
    candidate.cik,
    candidate.companyName,
    candidate.exchange,
    candidate.marketCap,
    candidate.priorityRank,
  );
}

export async function buildFundamentalSeedQueue(
  env: Env,
  options: { limit?: number; trigger?: "manual" | "scheduled" } = {},
): Promise<{
  ok: boolean;
  providerLabel: string;
  requestedLimit: number;
  fetchedRows: number;
  marketEligibleRows: number;
  universeEligibleRows: number;
  queuedRows: number;
  skippedNoIssuer: number;
  completedAt: string;
}> {
  const db = await requireFundamentalSeedSchema(env);
  const requestedLimit = Math.max(1, Math.min(3000, Number(options.limit ?? 500)));
  const startedAt = new Date().toISOString();
  const runId = makeRunId("fund-seed-build");

  try {
    const [{ rows, fetchedRows }, issuerMap, universe] = await Promise.all([
      fetchTradingViewMarketCapRows(requestedLimit),
      loadFundamentalIssuerMap(env),
      loadSavedEquityUniverse(env),
    ]);

    const marketEligible = rows.filter(isEligibleTradingViewMarketCapRow);
    const universeEligible = marketEligible.filter((row) => universe.has(row.ticker));
    const candidates = dedupeCandidates(
      universeEligible
        .map<SeedQueueCandidate | null>((row, index) => {
          const issuer = issuerMap.get(row.ticker);
          if (!issuer) return null;
          return {
            ticker: row.ticker,
            cik: issuer.cik,
            companyName: row.companyName ?? issuer.companyName,
            exchange: row.exchange,
            marketCap: row.marketCap,
            priorityRank: index + 1,
          };
        })
        .filter((row): row is SeedQueueCandidate => row != null),
    ).slice(0, requestedLimit);

    await runStatementsInChunks(db, candidates.map((candidate) => toQueueUpsert(db, candidate)));
    const completedAt = new Date().toISOString();
    await recordSeedRun(db, {
      id: runId,
      runType: "build",
      trigger: options.trigger ?? "manual",
      requestedLimit,
      startedAt,
      completedAt,
      fetchedRows,
      eligibleRows: candidates.length,
      queuedRows: candidates.length,
    });

    return {
      ok: true,
      providerLabel: TV_PROVIDER_LABEL,
      requestedLimit,
      fetchedRows,
      marketEligibleRows: marketEligible.length,
      universeEligibleRows: universeEligible.length,
      queuedRows: candidates.length,
      skippedNoIssuer: universeEligible.length - candidates.length,
      completedAt,
    };
  } catch (error) {
    const completedAt = new Date().toISOString();
    await recordSeedRun(db, {
      id: runId,
      runType: "build",
      trigger: options.trigger ?? "manual",
      requestedLimit,
      startedAt,
      completedAt,
      error: error instanceof Error ? error.message : "Failed to build fundamentals seed queue.",
    });
    throw error;
  }
}

async function loadDueSeedQueueRows(db: D1Database, limit: number, now: Date): Promise<SeedQueueRow[]> {
  const rows = await db.prepare(
    `SELECT
       ticker,
       cik,
       company_name as companyName,
       exchange,
       market_cap as marketCap,
       priority_rank as priorityRank,
       status,
       attempts
     FROM fundamental_seed_queue
     WHERE status IN ('queued', 'error')
       AND (next_attempt_at IS NULL OR datetime(next_attempt_at) <= datetime(?))
     ORDER BY priority_rank ASC, ticker ASC
     LIMIT ?`,
  ).bind(now.toISOString(), limit).all<SeedQueueRow>();
  return rows.results ?? [];
}

function nextAttemptAt(attempts: number, now: Date): string {
  const minutes = Math.min(24 * 60, 30 * Math.pow(2, Math.max(0, attempts - 1)));
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}

async function markQueueRunning(db: D1Database, row: SeedQueueRow): Promise<void> {
  await db.prepare(
    `UPDATE fundamental_seed_queue
     SET status = 'running', attempts = ?, last_error = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE ticker = ?`,
  ).bind(row.attempts + 1, row.ticker).run();
}

async function markQueueSuccess(
  db: D1Database,
  row: SeedQueueRow,
  status: "ok" | "no_supported_rows",
  input: { rowsUpserted: number; latestPeriodEnd: string | null; latestFiledAt: string | null; refreshedAt: string; error?: string | null },
): Promise<void> {
  await db.prepare(
    `UPDATE fundamental_seed_queue
     SET status = ?,
         rows_upserted = ?,
         latest_period_end = ?,
         latest_filed_at = ?,
         last_refreshed_at = ?,
         last_error = ?,
         next_attempt_at = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE ticker = ?`,
  ).bind(
    status,
    input.rowsUpserted,
    input.latestPeriodEnd,
    input.latestFiledAt,
    input.refreshedAt,
    input.error ?? null,
    row.ticker,
  ).run();
}

async function markQueueError(db: D1Database, row: SeedQueueRow, error: unknown, now: Date): Promise<string> {
  const message = error instanceof Error ? error.message : "Failed to refresh SEC fundamentals.";
  const attempts = row.attempts + 1;
  await db.prepare(
    `UPDATE fundamental_seed_queue
     SET status = 'error',
         last_error = ?,
         next_attempt_at = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE ticker = ?`,
  ).bind(message.slice(0, 700), nextAttemptAt(attempts, now), row.ticker).run();
  return message;
}

function issuerFromQueue(row: SeedQueueRow): FundamentalIssuer {
  return {
    ticker: row.ticker,
    cik: row.cik,
    companyName: row.companyName,
  };
}

export async function processFundamentalSeedQueue(
  env: Env,
  options: { limit?: number; trigger?: "manual" | "scheduled"; now?: Date } = {},
): Promise<{
  ok: boolean;
  attempted: number;
  rows: Array<{ ticker: string; previousStatus: string; status: string; rowsUpserted: number; latestPeriodEnd: string | null; latestFiledAt: string | null; error: string | null }>;
}> {
  const db = await requireFundamentalSeedSchema(env);
  const limit = Math.max(1, Math.min(PROCESS_LIMIT_MAX, Number(options.limit ?? 10)));
  const now = options.now ?? new Date();
  const startedAt = new Date().toISOString();
  const runId = makeRunId("fund-seed-process");
  const queueRows = await loadDueSeedQueueRows(db, limit, now);
  const processedRows: Array<{ ticker: string; previousStatus: string; status: string; rowsUpserted: number; latestPeriodEnd: string | null; latestFiledAt: string | null; error: string | null }> = [];

  for (const row of queueRows) {
    await markQueueRunning(db, row);
    try {
      const result = await refreshTickerFundamentals(env, row.ticker, {
        maxRows: 16,
        issuerOverride: issuerFromQueue(row),
      });
      const nextStatus = result.rowsUpserted > 0 ? "ok" : "no_supported_rows";
      const error = nextStatus === "no_supported_rows"
        ? "SEC companyfacts returned no supported revenue/net income rows."
        : null;
      await markQueueSuccess(db, row, nextStatus, {
        rowsUpserted: result.rowsUpserted,
        latestPeriodEnd: result.latestPeriodEnd,
        latestFiledAt: result.latestFiledAt,
        refreshedAt: result.refreshedAt,
        error,
      });
      processedRows.push({
        ticker: row.ticker,
        previousStatus: row.status,
        status: nextStatus,
        rowsUpserted: result.rowsUpserted,
        latestPeriodEnd: result.latestPeriodEnd,
        latestFiledAt: result.latestFiledAt,
        error,
      });
    } catch (error) {
      const message = await markQueueError(db, row, error, now);
      processedRows.push({
        ticker: row.ticker,
        previousStatus: row.status,
        status: "error",
        rowsUpserted: 0,
        latestPeriodEnd: null,
        latestFiledAt: null,
        error: message,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, PROCESS_DELAY_MS));
  }

  const completedAt = new Date().toISOString();
  await recordSeedRun(db, {
    id: runId,
    runType: "process",
    trigger: options.trigger ?? "manual",
    requestedLimit: limit,
    startedAt,
    completedAt,
    processedRows: processedRows.length,
    okRows: processedRows.filter((row) => row.status === "ok").length,
    errorRows: processedRows.filter((row) => row.status === "error").length,
    noSupportedRows: processedRows.filter((row) => row.status === "no_supported_rows").length,
  });

  return { ok: true, attempted: queueRows.length, rows: processedRows };
}

export async function maybeProcessFundamentalSeedQueue(env: Env, now = new Date()): Promise<Awaited<ReturnType<typeof processFundamentalSeedQueue>> | null> {
  const db = fundamentalsDb(env);
  if (!db || !(await hasFundamentalSeedSchema(db))) return null;
  const due = await db.prepare(
    `SELECT COUNT(*) as count
     FROM fundamental_seed_queue
     WHERE status IN ('queued', 'error')
       AND (next_attempt_at IS NULL OR datetime(next_attempt_at) <= datetime(?))`,
  ).bind(now.toISOString()).first<DbCountRow>();
  if (Number(due?.count ?? 0) <= 0) return null;
  return processFundamentalSeedQueue(env, { limit: 3, trigger: "scheduled", now });
}

function storageLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${Math.round(bytes)} B`;
}

function estimateStorageBytes(input: { issuerCount: number; quarterRowCount: number; queueRowCount: number }): number {
  return (input.issuerCount * 450) + (input.quarterRowCount * 950) + (input.queueRowCount * 650);
}

export async function loadFundamentalSeedStatus(env: Env): Promise<{
  schemaReady: boolean;
  warning: string | null;
  counts: Record<string, number>;
  cached: {
    issuerCount: number;
    quarterRowCount: number;
    tickerWithQuarterCount: number;
  };
  queue: {
    total: number;
    progressPct: number;
    nextTickers: Array<Record<string, unknown>>;
  };
  storageEstimate: {
    estimatedBytes: number;
    label: string;
    note: string;
  };
  recentRuns: Array<Record<string, unknown>>;
}> {
  const db = fundamentalsDb(env);
  if (!db) {
    return {
      schemaReady: false,
      warning: "FUNDAMENTALS_DB binding is not configured.",
      counts: {},
      cached: { issuerCount: 0, quarterRowCount: 0, tickerWithQuarterCount: 0 },
      queue: { total: 0, progressPct: 0, nextTickers: [] },
      storageEstimate: { estimatedBytes: 0, label: "0 B", note: "D1 file size is not available inside the Worker; this is a row-count estimate." },
      recentRuns: [],
    };
  }
  if (!(await hasFundamentalSeedSchema(db))) {
    return {
      schemaReady: false,
      warning: "Fundamentals seed schema is missing. Apply worker/fundamentals-migrations/0003_fundamentals_seed_queue.sql.",
      counts: {},
      cached: { issuerCount: 0, quarterRowCount: 0, tickerWithQuarterCount: 0 },
      queue: { total: 0, progressPct: 0, nextTickers: [] },
      storageEstimate: { estimatedBytes: 0, label: "0 B", note: "D1 file size is not available inside the Worker; this is a row-count estimate." },
      recentRuns: [],
    };
  }

  const [
    countRows,
    issuerCount,
    quarterRowCount,
    tickerWithQuarterCount,
    nextTickers,
    recentRuns,
  ] = await Promise.all([
    db.prepare("SELECT status, COUNT(*) as count FROM fundamental_seed_queue GROUP BY status ORDER BY status ASC").all<QueueCountRow>(),
    db.prepare("SELECT COUNT(*) as count FROM fundamental_issuers").first<DbCountRow>(),
    db.prepare("SELECT COUNT(*) as count FROM fundamental_quarters").first<DbCountRow>(),
    db.prepare("SELECT COUNT(DISTINCT ticker) as count FROM fundamental_quarters").first<DbCountRow>(),
    db.prepare(
      `SELECT ticker, company_name as companyName, exchange, market_cap as marketCap, priority_rank as priorityRank, status, attempts, next_attempt_at as nextAttemptAt
       FROM fundamental_seed_queue
       WHERE status IN ('queued', 'error')
       ORDER BY priority_rank ASC, ticker ASC
       LIMIT 20`,
    ).all<Record<string, unknown>>(),
    db.prepare(
      `SELECT id, run_type as runType, trigger, requested_limit as requestedLimit, fetched_rows as fetchedRows,
              eligible_rows as eligibleRows, queued_rows as queuedRows, processed_rows as processedRows,
              ok_rows as okRows, error_rows as errorRows, no_supported_rows as noSupportedRows,
              started_at as startedAt, completed_at as completedAt, error
       FROM fundamental_seed_runs
       ORDER BY created_at DESC
       LIMIT 10`,
    ).all<Record<string, unknown>>(),
  ]);

  const counts = Object.fromEntries((countRows.results ?? []).map((row) => [row.status, Number(row.count ?? 0)]));
  const total = Object.values(counts).reduce((sum, value) => sum + Number(value ?? 0), 0);
  const completed = Number(counts.ok ?? 0) + Number(counts.no_supported_rows ?? 0) + Number(counts.skipped ?? 0);
  const storageBytes = estimateStorageBytes({
    issuerCount: Number(issuerCount?.count ?? 0),
    quarterRowCount: Number(quarterRowCount?.count ?? 0),
    queueRowCount: total,
  });

  return {
    schemaReady: true,
    warning: null,
    counts,
    cached: {
      issuerCount: Number(issuerCount?.count ?? 0),
      quarterRowCount: Number(quarterRowCount?.count ?? 0),
      tickerWithQuarterCount: Number(tickerWithQuarterCount?.count ?? 0),
    },
    queue: {
      total,
      progressPct: total > 0 ? Number(((completed / total) * 100).toFixed(1)) : 0,
      nextTickers: nextTickers.results ?? [],
    },
    storageEstimate: {
      estimatedBytes: storageBytes,
      label: storageLabel(storageBytes),
      note: "D1 file size is not available inside the Worker; this is a row-count estimate.",
    },
    recentRuns: recentRuns.results ?? [],
  };
}

export async function loadFundamentalSeedErrors(
  env: Env,
  options: { limit?: number } = {},
): Promise<{ schemaReady: boolean; rows: Array<Record<string, unknown>>; warning: string | null }> {
  const db = fundamentalsDb(env);
  if (!db) return { schemaReady: false, rows: [], warning: "FUNDAMENTALS_DB binding is not configured." };
  if (!(await hasFundamentalSeedSchema(db))) {
    return {
      schemaReady: false,
      rows: [],
      warning: "Fundamentals seed schema is missing. Apply worker/fundamentals-migrations/0003_fundamentals_seed_queue.sql.",
    };
  }
  const limit = Math.max(1, Math.min(100, Number(options.limit ?? 50)));
  const rows = await db.prepare(
    `SELECT ticker, company_name as companyName, exchange, market_cap as marketCap,
            priority_rank as priorityRank, status, attempts, rows_upserted as rowsUpserted,
            latest_period_end as latestPeriodEnd, latest_filed_at as latestFiledAt,
            last_refreshed_at as lastRefreshedAt, next_attempt_at as nextAttemptAt,
            last_error as lastError, updated_at as updatedAt
     FROM fundamental_seed_queue
     WHERE status IN ('error', 'no_supported_rows', 'skipped') OR last_error IS NOT NULL
     ORDER BY datetime(updated_at) DESC, priority_rank ASC
     LIMIT ?`,
  ).bind(limit).all<Record<string, unknown>>();
  return { schemaReady: true, rows: rows.results ?? [], warning: null };
}
