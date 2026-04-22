import { buildRelativeStrengthSeries, computeBreadthStats, computeMetrics, isPriceAboveSma, rankValue, sanitizeBarSeries } from "./metrics";
import { loadConfig } from "./db";
import { refreshDailyBarsIncremental } from "./daily-bars";
import { getProvider } from "./provider";
import { SP500_TICKERS } from "./sp500-tickers";
import { latestUsSessionAsOfDate } from "./refresh-timing";
import { loadNasdaqTraderUniverses, loadRussell2000Constituents, loadSp500Constituents } from "./universe-constituents";
import type { Env, SnapshotResponse } from "./types";

const uid = () => crypto.randomUUID();

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const pctChange = (now: number, then: number): number => {
  if (!Number.isFinite(now) || !Number.isFinite(then) || then === 0) return 0;
  return ((now - then) / then) * 100;
};

function previousWeekday(date: Date): Date {
  const d = new Date(date);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return d;
}

function resolveAsOfDate(asOfDateInput?: string): string {
  if (!asOfDateInput) return latestUsSessionAsOfDate(new Date());
  return toISODate(previousWeekday(new Date(`${asOfDateInput}T00:00:00Z`)));
}

const OVERALL_BREADTH_UNIVERSE_ID = "overall-market-proxy";
const NYSE_BREADTH_UNIVERSE_ID = "nyse-core";
const DB_BATCH_CHUNK_SIZE = 200;
const BAR_QUERY_TICKER_CHUNK_SIZE = 80;
const MIN_BREADTH_COVERAGE_PCT = 1;
const OVERVIEW_RS_ENABLED_GROUPS = new Set([
  "g-crypto",
  "g-metals-energy",
  "g-global",
  "g-country",
  "g-market-leaders",
  "g-thematic",
  "g-sector-etf",
  "g-sector-etf-eqwt",
]);
const OVERVIEW_RS_BENCHMARK_TICKER = "SPY";
const OVERVIEW_SNAPSHOT_RETENTION_DAYS = 14;
const SNAPSHOT_RETENTION_DELETE_CHUNK_SIZE = 25;

const SP500_SOURCE_LABEL = "S&P 500 constituents (datasets/s-and-p-500-companies CSV) + provider daily bars";
const NASDAQ_SOURCE_LABEL = "NasdaqTrader nasdaqtraded.txt (common-stock filter, listing exchange Q) + provider daily bars";
const NYSE_SOURCE_LABEL = "NasdaqTrader nasdaqtraded.txt (common-stock filter, listing exchange N) + provider daily bars";
const RUSSELL2000_SOURCE_LABEL =
  "Russell 2000 constituents (LSEG constituents table, filtered to NasdaqTrader common stocks) + provider daily bars";
const OVERALL_SOURCE_LABEL = "NasdaqTrader all US common stocks (same filter set) + provider daily bars";

type BreadthUniverseState = {
  universeTickers: Map<string, string[]>;
  sourceByUniverse: Map<string, string>;
  unavailable: Array<{ id: string; name: string; reason: string }>;
};

type UniverseSourceStatus = {
  lastSyncedAt: string | null;
  status: string | null;
  error: string | null;
  recordsCount: number | null;
};

function isStatusStale(lastSyncedAt: string | null | undefined, maxAgeDays = 14): boolean {
  if (!lastSyncedAt) return true;
  const t = new Date(lastSyncedAt).getTime();
  if (Number.isNaN(t)) return true;
  return Date.now() - t > maxAgeDays * 86400_000;
}

async function runStatementsInChunks(env: Env, statements: D1PreparedStatement[], chunkSize = DB_BATCH_CHUNK_SIZE): Promise<void> {
  for (let i = 0; i < statements.length; i += chunkSize) {
    const chunk = statements.slice(i, i + chunkSize);
    if (chunk.length === 0) continue;
    await env.DB.batch(chunk);
  }
}

function buildPlaceholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

export async function cleanupOldOverviewSnapshots(
  env: Env,
  retentionDays = OVERVIEW_SNAPSHOT_RETENTION_DAYS,
): Promise<{ cutoffDate: string; deletedSnapshots: number; deletedRows: number; deletedOrphanRows: number }> {
  const cutoffDate = toISODate(new Date(Date.now() - retentionDays * 86400_000));
  const orphanRowCount = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM snapshot_rows WHERE snapshot_id NOT IN (SELECT id FROM snapshots_meta)",
  ).first<{ count: number | null }>();
  const deletedOrphanRows = orphanRowCount?.count ?? 0;
  if (deletedOrphanRows > 0) {
    await env.DB.prepare(
      "DELETE FROM snapshot_rows WHERE snapshot_id NOT IN (SELECT id FROM snapshots_meta)",
    ).run();
  }
  const staleSnapshots = await env.DB.prepare(
    `SELECT sm.id as id
       FROM snapshots_meta sm
       LEFT JOIN (
         SELECT config_id, MAX(as_of_date) as latest_as_of_date
         FROM snapshots_meta
         GROUP BY config_id
       ) latest
         ON latest.config_id = sm.config_id
        AND latest.latest_as_of_date = sm.as_of_date
      WHERE sm.as_of_date < ?
        AND latest.latest_as_of_date IS NULL
      ORDER BY sm.generated_at ASC`,
  )
    .bind(cutoffDate)
    .all<{ id: string }>();
  const staleSnapshotIds = (staleSnapshots.results ?? []).map((row) => row.id).filter(Boolean);
  if (staleSnapshotIds.length === 0) {
    return {
      cutoffDate,
      deletedSnapshots: 0,
      deletedRows: deletedOrphanRows,
      deletedOrphanRows,
    };
  }

  let deletedRows = deletedOrphanRows;
  for (let i = 0; i < staleSnapshotIds.length; i += SNAPSHOT_RETENTION_DELETE_CHUNK_SIZE) {
    const chunk = staleSnapshotIds.slice(i, i + SNAPSHOT_RETENTION_DELETE_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const placeholders = buildPlaceholders(chunk.length);
    const rowCount = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM snapshot_rows WHERE snapshot_id IN (${placeholders})`,
    )
      .bind(...chunk)
      .first<{ count: number | null }>();
    deletedRows += rowCount?.count ?? 0;
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM snapshot_rows WHERE snapshot_id IN (${placeholders})`).bind(...chunk),
      env.DB.prepare(`DELETE FROM snapshots_meta WHERE id IN (${placeholders})`).bind(...chunk),
    ]);
  }

  return {
    cutoffDate,
    deletedSnapshots: staleSnapshotIds.length,
    deletedRows,
    deletedOrphanRows,
  };
}

async function ensureSymbolsExist(env: Env, tickers: string[]): Promise<void> {
  const unique = Array.from(new Set(tickers.map((t) => t.toUpperCase()).filter(Boolean)));
  if (unique.length === 0) return;
  const statements = unique.map((ticker) =>
    env.DB.prepare("INSERT OR IGNORE INTO symbols (ticker, name, asset_class) VALUES (?, ?, ?)")
      .bind(ticker, ticker, "equity"),
  );
  await runStatementsInChunks(env, statements);
}

async function loadBarsForTickers(
  env: Env,
  tickers: string[],
  asOfDate: string,
): Promise<Array<{ ticker: string; date: string; c: number; volume: number | null }>> {
  const unique = Array.from(new Set(tickers.map((t) => t.toUpperCase()).filter(Boolean)));
  const rows: Array<{ ticker: string; date: string; c: number; volume: number | null }> = [];
  for (let i = 0; i < unique.length; i += BAR_QUERY_TICKER_CHUNK_SIZE) {
    const chunk = unique.slice(i, i + BAR_QUERY_TICKER_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(", ");
    const sql = `SELECT ticker, date, c, volume FROM daily_bars WHERE ticker IN (${placeholders}) AND date <= ? ORDER BY ticker, date`;
    const result = await env.DB.prepare(sql)
      .bind(...chunk, asOfDate)
      .all<{ ticker: string; date: string; c: number; volume: number | null }>();
    rows.push(...(result.results ?? []));
  }
  return rows;
}

async function loadOverviewDerivedMetricsByTicker(
  env: Env,
  tickers: string[],
  asOfDate: string,
): Promise<Map<string, {
  change3m: number;
  change6m: number;
  above20Sma: boolean | null;
  above50Sma: boolean | null;
  above200Sma: boolean | null;
}>> {
  const unique = Array.from(new Set(tickers.map((t) => t.toUpperCase()).filter(Boolean)));
  if (unique.length === 0) return new Map();
  const startDate = toISODate(new Date(new Date(`${asOfDate}T00:00:00Z`).getTime() - 420 * 86400_000));
  const rows: Array<{ ticker: string; date: string; c: number; volume: number | null }> = [];
  for (let i = 0; i < unique.length; i += BAR_QUERY_TICKER_CHUNK_SIZE) {
    const chunk = unique.slice(i, i + BAR_QUERY_TICKER_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    const sql = `SELECT ticker, date, c, volume FROM daily_bars WHERE ticker IN (${placeholders}) AND date >= ? AND date <= ? ORDER BY ticker, date`;
    const result = await env.DB.prepare(sql)
      .bind(...chunk, startDate, asOfDate)
      .all<{ ticker: string; date: string; c: number; volume: number | null }>();
    rows.push(...(result.results ?? []));
  }
  const seriesByTicker = new Map<string, { dates: string[]; closes: number[] }>();
  for (const row of rows) {
    const key = row.ticker.toUpperCase();
    const values = seriesByTicker.get(key) ?? { dates: [], closes: [] };
    values.dates.push(row.date);
    values.closes.push(row.c);
    seriesByTicker.set(key, values);
  }
  const out = new Map<string, {
    change3m: number;
    change6m: number;
    above20Sma: boolean | null;
    above50Sma: boolean | null;
    above200Sma: boolean | null;
  }>();
  for (const ticker of unique) {
    const series = seriesByTicker.get(ticker) ?? { dates: [], closes: [] };
    const cleaned = sanitizeBarSeries(series.dates, series.closes);
    const closes = cleaned.closes;
    if (closes.length === 0) {
      out.set(ticker, {
        change3m: 0,
        change6m: 0,
        above20Sma: null,
        above50Sma: null,
        above200Sma: null,
      });
      continue;
    }
    const last = closes.length - 1;
    const price = closes[last];
    const prev3m = closes[Math.max(0, last - 63)];
    const prev6m = closes[Math.max(0, last - 126)];
    out.set(ticker, {
      change3m: pctChange(price, prev3m),
      change6m: pctChange(price, prev6m),
      above20Sma: isPriceAboveSma(closes, 20),
      above50Sma: isPriceAboveSma(closes, 50),
      above200Sma: isPriceAboveSma(closes, 200),
    });
  }
  return out;
}

async function loadOverviewRelativeStrengthPilot(
  env: Env,
  rows: Array<{ groupId: string; ticker: string }>,
  asOfDate: string,
): Promise<Map<string, number[] | null>> {
  const eligibleTickers = Array.from(new Set(
    rows
      .filter((row) => OVERVIEW_RS_ENABLED_GROUPS.has(row.groupId))
      .map((row) => row.ticker.toUpperCase())
      .filter(Boolean),
  ));
  if (eligibleTickers.length === 0) return new Map();

  const bars = await loadBarsForTickers(env, [...eligibleTickers, OVERVIEW_RS_BENCHMARK_TICKER], asOfDate);
  const seriesByTicker = new Map<string, { dates: string[]; closes: number[] }>();
  for (const row of bars) {
    const ticker = row.ticker.toUpperCase();
    const series = seriesByTicker.get(ticker) ?? { dates: [], closes: [] };
    series.dates.push(row.date);
    series.closes.push(row.c);
    seriesByTicker.set(ticker, series);
  }

  const benchmarkSeries = seriesByTicker.get(OVERVIEW_RS_BENCHMARK_TICKER) ?? { dates: [], closes: [] };
  const relativeStrengthByTicker = new Map<string, number[] | null>();
  for (const ticker of eligibleTickers) {
    const tickerSeries = seriesByTicker.get(ticker) ?? { dates: [], closes: [] };
    relativeStrengthByTicker.set(
      ticker,
      buildRelativeStrengthSeries(
        tickerSeries.dates,
        tickerSeries.closes,
        benchmarkSeries.dates,
        benchmarkSeries.closes,
      ),
    );
  }

  return relativeStrengthByTicker;
}

async function loadUniverseTickers(env: Env, universeId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT ticker FROM universe_symbols WHERE universe_id = ? ORDER BY ticker ASC",
  )
    .bind(universeId)
    .all<{ ticker: string }>();
  return Array.from(new Set((rows.results ?? []).map((r) => r.ticker.toUpperCase()).filter(Boolean)));
}

async function loadUniverseSourceStatus(env: Env, sourceKey: string): Promise<UniverseSourceStatus | null> {
  return await env.DB.prepare(
    "SELECT last_synced_at as lastSyncedAt, status, error, records_count as recordsCount FROM etf_constituent_sync_status WHERE etf_ticker = ? LIMIT 1",
  )
    .bind(sourceKey)
    .first<UniverseSourceStatus>();
}

async function saveUniverseSourceStatus(
  env: Env,
  sourceKey: string,
  status: "ok" | "error",
  source: string,
  recordsCount: number,
  errorMessage: string | null,
): Promise<void> {
  const errorText = errorMessage ? errorMessage.slice(0, 700) : null;
  await env.DB.prepare(
    "INSERT OR REPLACE INTO etf_constituent_sync_status (etf_ticker, last_synced_at, status, error, source, records_count, updated_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
  )
    .bind(sourceKey, new Date().toISOString(), status, errorText, source.slice(0, 120), recordsCount)
    .run();
}

async function ensureUniverseMembership(env: Env, universeId: string, universeName: string, tickers: string[]): Promise<void> {
  const unique = Array.from(new Set(tickers.map((t) => t.toUpperCase()).filter(Boolean)));
  if (unique.length === 0) return;
  await ensureSymbolsExist(env, unique);
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO universes (id, name) VALUES (?, ?)").bind(universeId, universeName),
    env.DB.prepare("DELETE FROM universe_symbols WHERE universe_id = ?").bind(universeId),
  ]);

  const chunkSize = 20;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const statements = chunk.map((ticker) =>
      env.DB.prepare("INSERT OR IGNORE INTO universe_symbols (universe_id, ticker) VALUES (?, ?)").bind(universeId, ticker),
    );
    await env.DB.batch(statements);
  }
}

type UniverseSyncDef = {
  id: string;
  name: string;
  sourceLabel: string;
  sourceKey: string;
  staleAfterDays: number;
  unavailableReason: string;
  fetchTickers: () => Promise<string[]>;
};

function dedupeTickers(tickers: string[]): string[] {
  return Array.from(new Set(tickers.map((ticker) => ticker.toUpperCase()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

async function syncUniverseFromSource(
  env: Env,
  def: UniverseSyncDef,
  universeTickers: Map<string, string[]>,
  sourceByUniverse: Map<string, string>,
  unavailable: Array<{ id: string; name: string; reason: string }>,
): Promise<void> {
  const existing = await loadUniverseTickers(env, def.id);
  const status = await loadUniverseSourceStatus(env, def.sourceKey);
  const shouldRefresh = existing.length === 0 || status?.status !== "ok" || isStatusStale(status?.lastSyncedAt, def.staleAfterDays);

  let tickers = existing;
  let sourceLabel = def.sourceLabel;

  if (shouldRefresh) {
    try {
      const fetched = dedupeTickers(await def.fetchTickers());
      if (fetched.length === 0) {
        throw new Error(`No tickers returned for ${def.id}`);
      }
      await ensureUniverseMembership(env, def.id, def.name, fetched);
      tickers = fetched;
      await saveUniverseSourceStatus(env, def.sourceKey, "ok", def.sourceLabel, fetched.length, null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "constituent sync failed";
      console.error("breadth universe source sync failed", { universeId: def.id, error: message });
      await saveUniverseSourceStatus(env, def.sourceKey, "error", def.sourceLabel, existing.length, message);
      if (existing.length === 0) {
        unavailable.push({
          id: def.id,
          name: def.name,
          reason: def.unavailableReason,
        });
        return;
      }
      sourceLabel = `${def.sourceLabel} (cached universe reused; latest sync attempt failed)`;
    }
  }

  if (tickers.length === 0) {
    unavailable.push({
      id: def.id,
      name: def.name,
      reason: def.unavailableReason,
    });
    return;
  }

  universeTickers.set(def.id, tickers);
  sourceByUniverse.set(def.id, sourceLabel);
}

async function ensureBreadthUniverseMemberships(env: Env): Promise<BreadthUniverseState> {
  const universeTickers = new Map<string, string[]>();
  const sourceByUniverse = new Map<string, string>();
  const unavailable: Array<{ id: string; name: string; reason: string }> = [];
  let nasdaqUniverseCache:
    | {
        nasdaqTickers: string[];
        nyseTickers: string[];
        allCommonTickers: string[];
      }
    | null = null;
  const loadNasdaqUniverseCache = async () => {
    if (!nasdaqUniverseCache) {
      nasdaqUniverseCache = await loadNasdaqTraderUniverses();
    }
    return nasdaqUniverseCache;
  };

  await syncUniverseFromSource(
    env,
    {
      id: "nasdaq-core",
      name: "NASDAQ",
      sourceLabel: NASDAQ_SOURCE_LABEL,
      sourceKey: "universe:nasdaq-core",
      staleAfterDays: 1,
      unavailableReason: "NASDAQ constituent source fetch failed and no cached NASDAQ membership is available",
      fetchTickers: async () => (await loadNasdaqUniverseCache()).nasdaqTickers,
    },
    universeTickers,
    sourceByUniverse,
    unavailable,
  );

  await syncUniverseFromSource(
    env,
    {
      id: NYSE_BREADTH_UNIVERSE_ID,
      name: "NYSE",
      sourceLabel: NYSE_SOURCE_LABEL,
      sourceKey: "universe:nyse-core",
      staleAfterDays: 1,
      unavailableReason: "NYSE constituent source fetch failed and no cached NYSE membership is available",
      fetchTickers: async () => (await loadNasdaqUniverseCache()).nyseTickers,
    },
    universeTickers,
    sourceByUniverse,
    unavailable,
  );

  await syncUniverseFromSource(
    env,
    {
      id: "sp500-core",
      name: "S&P 500",
      sourceLabel: SP500_SOURCE_LABEL,
      sourceKey: "universe:sp500-core",
      staleAfterDays: 7,
      unavailableReason: "S&P 500 constituent source fetch failed and no cached S&P 500 membership is available",
      fetchTickers: async () => {
        try {
          const allCommon = new Set((await loadNasdaqUniverseCache()).allCommonTickers);
          return await loadSp500Constituents(allCommon);
        } catch {
          return await loadSp500Constituents(undefined);
        }
      },
    },
    universeTickers,
    sourceByUniverse,
    unavailable,
  );

  await syncUniverseFromSource(
    env,
    {
      id: "russell2000-core",
      name: "Russell 2000",
      sourceLabel: RUSSELL2000_SOURCE_LABEL,
      sourceKey: "universe:russell2000-core",
      staleAfterDays: 14,
      unavailableReason: "Russell 2000 constituent source fetch failed and no cached Russell 2000 membership is available",
      fetchTickers: async () => {
        const allCommon = new Set((await loadNasdaqUniverseCache()).allCommonTickers);
        return await loadRussell2000Constituents(allCommon);
      },
    },
    universeTickers,
    sourceByUniverse,
    unavailable,
  );

  await syncUniverseFromSource(
    env,
    {
      id: OVERALL_BREADTH_UNIVERSE_ID,
      name: "Overall Market",
      sourceLabel: OVERALL_SOURCE_LABEL,
      sourceKey: "universe:overall-market-core",
      staleAfterDays: 1,
      unavailableReason: "Overall-market constituent source fetch failed and no cached overall-market membership is available",
      fetchTickers: async () => (await loadNasdaqUniverseCache()).allCommonTickers,
    },
    universeTickers,
    sourceByUniverse,
    unavailable,
  );

  if (!universeTickers.has(OVERALL_BREADTH_UNIVERSE_ID)) {
    const unionTickers = dedupeTickers([...universeTickers.values()].flat());
    if (unionTickers.length > 0) {
      await ensureUniverseMembership(env, OVERALL_BREADTH_UNIVERSE_ID, "Overall Market", unionTickers);
      universeTickers.set(OVERALL_BREADTH_UNIVERSE_ID, unionTickers);
      sourceByUniverse.set(OVERALL_BREADTH_UNIVERSE_ID, "Union of available non-proxy universes + provider daily bars");
    }
  }

  unavailable.push({
    id: "worden-common-stock-universe",
    name: "Overall Market (Worden Common Stock Universe)",
    reason: "Proprietary universe; no free direct feed is available",
  });

  return { universeTickers, sourceByUniverse, unavailable };
}

type SnapshotComputeOptions = {
  includeBreadth?: boolean;
  pullProviderBars?: boolean;
  providerTickers?: string[] | null;
};

export async function computeAndStoreSnapshot(
  env: Env,
  asOfDateInput?: string,
  configId = "default",
  options: SnapshotComputeOptions = {},
): Promise<{ snapshotId: string; asOfDate: string }> {
  const includeBreadth = options.includeBreadth ?? true;
  const pullProviderBars = options.pullProviderBars ?? true;
  const asOfDate = resolveAsOfDate(asOfDateInput);
  const generatedAt = new Date().toISOString();
  const config = await loadConfig(env, configId);
  let providerLabel = "Stored Daily Bars";
  const provider = pullProviderBars
    ? (() => {
      try {
        const p = getProvider(env);
        providerLabel = p.label;
        return p;
      } catch (error) {
        console.error("provider init failed, using stored bars only", error);
        return null;
      }
    })()
    : null;

  const dashboardTickers = Array.from(
    new Set(
      config.sections
        .flatMap((s) => s.groups)
        .flatMap((g) => g.items)
        .filter((it) => it.enabled)
        .map((it) => it.ticker),
    ),
  );
  const breadthState = includeBreadth
    ? await (async (): Promise<BreadthUniverseState> => {
      try {
        return await ensureBreadthUniverseMemberships(env);
      } catch (error) {
        console.error("breadth universe setup failed; continuing with existing memberships", error);
        return {
          universeTickers: new Map<string, string[]>(),
          sourceByUniverse: new Map<string, string>(),
          unavailable: [],
        };
      }
    })()
    : {
      universeTickers: new Map<string, string[]>(),
      sourceByUniverse: new Map<string, string>(),
      unavailable: [],
    };
  const breadthTickers = Array.from(new Set([...breadthState.universeTickers.values()].flat()));
  const tickers = Array.from(new Set(options.providerTickers ?? [...dashboardTickers, ...breadthTickers]));

  const endDate = asOfDate;
  const startDate = toISODate(new Date(new Date(`${asOfDate}T00:00:00Z`).getTime() - 320 * 86400_000));
  if (provider) {
    try {
      await refreshDailyBarsIncremental(env, { provider, tickers, startDate, endDate });
    } catch (error) {
      providerLabel = `${provider.label} (refresh failed; stored bars used)`;
      console.error("provider refresh failed", error);
    }
  }

  const barRows = await env.DB.prepare(
    "SELECT ticker, date, c FROM daily_bars WHERE ticker IN (SELECT ticker FROM dashboard_items) AND date <= ? ORDER BY ticker, date",
  )
    .bind(asOfDate)
    .all<{ ticker: string; date: string; c: number }>();

  const symbols = await env.DB.prepare("SELECT ticker, name FROM symbols").all<{ ticker: string; name: string }>();
  const symbolNameMap = new Map((symbols.results ?? []).map((s) => [s.ticker, s.name]));

  const barsByTicker = new Map<string, { dates: string[]; closes: number[] }>();
  for (const row of barRows.results ?? []) {
    const existing = barsByTicker.get(row.ticker) ?? { dates: [], closes: [] };
    existing.dates.push(row.date);
    existing.closes.push(row.c);
    barsByTicker.set(row.ticker, existing);
  }

  const preCleanup = await cleanupOldOverviewSnapshots(env);
  if (preCleanup.deletedSnapshots > 0 || preCleanup.deletedRows > 0) {
    console.log("overview snapshot cleanup removed old rows before refresh", preCleanup);
  }
  const snapshotId = uid();
  const previousSnapshot = await env.DB.prepare(
    "SELECT id FROM snapshots_meta WHERE config_id = ? AND as_of_date = ? LIMIT 1",
  )
    .bind(configId, asOfDate)
    .first<{ id: string }>();

  const rowInserts = [];
  for (const section of config.sections) {
    for (const group of section.groups) {
      const rows = group.items
        .filter((item) => item.enabled)
        .map((item) => {
          const bars = barsByTicker.get(item.ticker);
          const metrics = computeMetrics(bars?.dates ?? [], bars?.closes ?? []);
          return {
            ticker: item.ticker,
            displayName: item.displayName ?? symbolNameMap.get(item.ticker) ?? item.ticker,
            holdings: item.holdings,
            ...metrics,
            rankKey: rankValue(metrics, group.rankingWindowDefault),
          };
        })
        .sort((a, b) => b.rankKey - a.rankKey);

      for (const row of rows) {
        rowInserts.push(
          env.DB.prepare(
            "INSERT OR REPLACE INTO snapshot_rows (snapshot_id, section_id, group_id, ticker, display_name, price, change_1d, change_1w, change_5d, change_21d, ytd, pct_from_52w_high, sparkline_json, rank_key, holdings_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ).bind(
            snapshotId,
            section.id,
            group.id,
            row.ticker,
            row.displayName,
            row.price,
            row.change1d,
            row.change1w,
            row.change5d,
            row.change21d,
            row.ytd,
            row.pctFrom52wHigh,
            JSON.stringify(row.sparkline),
            row.rankKey,
            row.holdings ? JSON.stringify(row.holdings) : null,
          ),
        );
      }
    }
  }
  if (rowInserts.length > 0) await runStatementsInChunks(env, rowInserts);
  await env.DB.prepare(
    `INSERT INTO snapshots_meta (id, config_id, as_of_date, generated_at, provider_label)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(config_id, as_of_date) DO UPDATE SET
       id = excluded.id,
       generated_at = excluded.generated_at,
       provider_label = excluded.provider_label`,
  )
    .bind(snapshotId, configId, asOfDate, generatedAt, providerLabel)
    .run();
  if (previousSnapshot?.id && previousSnapshot.id !== snapshotId) {
    await env.DB.prepare("DELETE FROM snapshot_rows WHERE snapshot_id = ?")
      .bind(previousSnapshot.id)
      .run();
  }
  if (includeBreadth) {
    const breadthUniverseIds = Array.from(new Set<string>(breadthState.universeTickers.keys()));
    for (const universeId of breadthUniverseIds) {
      await computeAndStoreBreadth(
        env,
        asOfDate,
        universeId,
        breadthState.sourceByUniverse.get(universeId) ?? null,
        generatedAt,
      );
    }
  }
  const postCleanup = await cleanupOldOverviewSnapshots(env);
  if (postCleanup.deletedSnapshots > 0 || postCleanup.deletedRows > 0) {
    console.log("overview snapshot cleanup removed old rows after refresh", postCleanup);
  }
  return { snapshotId, asOfDate };
}

export async function recomputeDashboardFromStoredBars(
  env: Env,
  asOfDateInput?: string,
  configId = "default",
): Promise<{ snapshotId: string; asOfDate: string }> {
  return computeAndStoreSnapshot(env, asOfDateInput, configId, {
    includeBreadth: false,
    pullProviderBars: false,
  });
}

export async function recomputeBreadthFromStoredBars(
  env: Env,
  asOfDateInput?: string,
): Promise<{ asOfDate: string; universeCount: number; unavailable: Array<{ id: string; name: string; reason: string }> }> {
  const asOfDate = resolveAsOfDate(asOfDateInput);
  const generatedAt = new Date().toISOString();
  const breadthState = await ensureBreadthUniverseMemberships(env);
  const universeIds = Array.from(new Set<string>(breadthState.universeTickers.keys()));
  for (const universeId of universeIds) {
    await computeAndStoreBreadth(env, asOfDate, universeId, breadthState.sourceByUniverse.get(universeId) ?? null, generatedAt);
  }
  return {
    asOfDate,
    universeCount: universeIds.length,
    unavailable: breadthState.unavailable,
  };
}

export async function refreshSp500CoreBreadth(env: Env, asOfDateInput?: string): Promise<{ asOfDate: string; barCount: number }> {
  const asOfDate = resolveAsOfDate(asOfDateInput);
  let tickers: string[] = [];
  try {
    const nasdaqUniverse = await loadNasdaqTraderUniverses();
    tickers = await loadSp500Constituents(new Set(nasdaqUniverse.allCommonTickers));
    await saveUniverseSourceStatus(env, "universe:sp500-core", "ok", SP500_SOURCE_LABEL, tickers.length, null);
  } catch (error) {
    console.error("sp500 constituent refresh failed; using cached membership fallback", error);
    await saveUniverseSourceStatus(
      env,
      "universe:sp500-core",
      "error",
      SP500_SOURCE_LABEL,
      0,
      error instanceof Error ? error.message : "sp500 constituent refresh failed",
    );
    tickers = await loadUniverseTickers(env, "sp500-core");
  }
  if (tickers.length === 0) {
    tickers = [...SP500_TICKERS];
  }
  await ensureUniverseMembership(env, "sp500-core", "S&P 500", tickers);
  await ensureSymbolsExist(env, tickers);

  let barCount = 0;
  try {
    const provider = getProvider(env);
    const endDate = asOfDate;
    const startDate = toISODate(new Date(new Date(`${asOfDate}T00:00:00Z`).getTime() - 320 * 86400_000));
    const refresh = await refreshDailyBarsIncremental(env, { provider, tickers, startDate, endDate });
    barCount = refresh.writtenRows;
  } catch (error) {
    console.error("sp500 core breadth refresh provider pull failed; using stored bars", error);
  }

  await computeAndStoreBreadth(env, asOfDate, "sp500-core", SP500_SOURCE_LABEL, new Date().toISOString());
  return { asOfDate, barCount };
}

export async function computeAndStoreBreadth(
  env: Env,
  asOfDate: string,
  universeId: string,
  dataSource: string | null = null,
  generatedAt = new Date().toISOString(),
): Promise<void> {
  const members = await env.DB.prepare("SELECT ticker FROM universe_symbols WHERE universe_id = ?")
    .bind(universeId)
    .all<{ ticker: string }>();
  const tickers = (members.results ?? []).map((r) => r.ticker);
  if (tickers.length === 0) return;
  const allRows = await loadBarsForTickers(env, tickers, asOfDate);

  const barsByTicker = new Map<string, { closes: number[]; volumes: number[] }>();
  for (const r of allRows) {
    const v = barsByTicker.get(r.ticker) ?? { closes: [], volumes: [] };
    v.closes.push(r.c);
    v.volumes.push(r.volume ?? 0);
    barsByTicker.set(r.ticker, v);
  }

  const stats = computeBreadthStats(
    Object.fromEntries(
      tickers.map((t) => [
        t,
        barsByTicker.get(t) ?? {
          closes: [],
          volumes: [],
        },
      ]),
    ),
  );
  const isCoreUniverse = universeId.endsWith("-core") || universeId === OVERALL_BREADTH_UNIVERSE_ID;
  if (isCoreUniverse && stats.totalUniverseMembers > 0 && stats.dataCoveragePct < MIN_BREADTH_COVERAGE_PCT) {
    const id = `${asOfDate}:${universeId}`;
    await env.DB.prepare("DELETE FROM breadth_snapshots WHERE id = ?").bind(id).run();
    console.warn("skipping low-coverage breadth snapshot", {
      universeId,
      asOfDate,
      coveragePct: Number(stats.dataCoveragePct.toFixed(2)),
      memberCount: stats.memberCount,
      totalUniverseMembers: stats.totalUniverseMembers,
    });
    return;
  }

  const id = `${asOfDate}:${universeId}`;
  await env.DB.prepare(
    "INSERT OR REPLACE INTO breadth_snapshots (id, as_of_date, universe_id, advancers, decliners, unchanged, pct_above_20ma, pct_above_50ma, pct_above_200ma, new_20d_highs, new_20d_lows, median_return_1d, median_return_5d, sentiment_json, generated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      asOfDate,
      universeId,
      stats.advancers,
      stats.decliners,
      stats.unchanged,
      stats.pctAbove20MA,
      stats.pctAbove50MA,
      stats.pctAbove200MA,
      stats.new20DHighs,
      stats.new20DLows,
      stats.medianReturn1D,
      stats.medianReturn5D,
      JSON.stringify({
        fearGreed: null,
        putCall: null,
        metrics: stats,
        dataSource,
      }),
      generatedAt,
    )
    .run();
}

export async function loadSnapshot(env: Env, configId = "default", requestedDate?: string): Promise<SnapshotResponse> {
  const config = await loadConfig(env, configId);
  const latestAllowedAsOfDate = latestUsSessionAsOfDate(new Date());
  const meta = requestedDate
    ? await env.DB.prepare(
        "SELECT id, as_of_date as asOfDate, generated_at as generatedAt, provider_label as providerLabel FROM snapshots_meta WHERE config_id = ? AND as_of_date = ?",
      )
        .bind(configId, requestedDate)
        .first<{ id: string; asOfDate: string; generatedAt: string; providerLabel: string }>()
    : await env.DB.prepare(
        "SELECT id, as_of_date as asOfDate, generated_at as generatedAt, provider_label as providerLabel FROM snapshots_meta WHERE config_id = ? AND as_of_date <= ? ORDER BY as_of_date DESC, generated_at DESC LIMIT 1",
      )
        .bind(configId, latestAllowedAsOfDate)
        .first<{ id: string; asOfDate: string; generatedAt: string; providerLabel: string }>();

  if (!meta) {
    const computed = await computeAndStoreSnapshot(env, requestedDate, configId);
    return loadSnapshot(env, configId, computed.asOfDate);
  }

  const rows = await env.DB.prepare(
    "SELECT section_id as sectionId, group_id as groupId, ticker, display_name as displayName, price, change_1d as change1d, change_1w as change1w, change_5d as change5d, change_21d as change21d, ytd, pct_from_52w_high as pctFrom52wHigh, sparkline_json as sparklineJson, rank_key as rankKey, holdings_json as holdingsJson FROM snapshot_rows WHERE snapshot_id = ? ORDER BY rank_key DESC",
  )
    .bind(meta.id)
    .all<{
      sectionId: string;
      groupId: string;
      ticker: string;
      displayName: string | null;
      price: number;
      change1d: number;
      change1w: number;
      change5d: number;
      change21d: number;
      ytd: number;
      pctFrom52wHigh: number;
      sparklineJson: string;
      rankKey: number;
      holdingsJson: string | null;
    }>();

  const tableRows = rows.results ?? [];
  const derivedMetrics = await loadOverviewDerivedMetricsByTicker(
    env,
    Array.from(new Set(tableRows.map((row) => row.ticker))),
    meta.asOfDate,
  );
  const relativeStrengthByTicker = await loadOverviewRelativeStrengthPilot(
    env,
    tableRows.map((row) => ({ groupId: row.groupId, ticker: row.ticker })),
    meta.asOfDate,
  );
  return {
    asOfDate: meta.asOfDate,
    generatedAt: meta.generatedAt,
    providerLabel: meta.providerLabel,
    config,
    sections: config.sections.map((sec) => ({
      id: sec.id,
      title: sec.title,
      description: sec.description,
      groups: sec.groups.map((g) => ({
        id: g.id,
        title: g.title,
        dataType: g.dataType,
        rankingWindowDefault: g.rankingWindowDefault,
        showSparkline: g.showSparkline,
        pinTop10: g.pinTop10,
        columns: g.columns,
        rows: tableRows
          .filter((r) => r.sectionId === sec.id && r.groupId === g.id)
          .map((r) => ({
            ...(derivedMetrics.get(r.ticker.toUpperCase()) ?? {
              change3m: 0,
              change6m: 0,
              above20Sma: null,
              above50Sma: null,
              above200Sma: null,
            }),
            ticker: r.ticker,
            displayName: r.displayName,
            price: r.price,
            change1d: r.change1d,
            change1w: r.change1w,
            change5d: r.change5d,
            change21d: r.change21d,
            ytd: r.ytd,
            pctFrom52wHigh: r.pctFrom52wHigh,
            sparkline: JSON.parse(r.sparklineJson) as number[],
            relativeStrength30dVsSpy: relativeStrengthByTicker.get(r.ticker.toUpperCase()) ?? null,
            rankKey: r.rankKey,
            holdings: r.holdingsJson ? (JSON.parse(r.holdingsJson) as string[]) : null,
          })),
      })),
    })),
  };
}
