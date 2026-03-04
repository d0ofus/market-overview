import { computeBreadthStats, computeMetrics, rankValue } from "./metrics";
import { loadConfig } from "./db";
import { getProvider } from "./provider";
import { syncEtfConstituents } from "./etf";
import type { Env, SnapshotResponse } from "./types";

const uid = () => crypto.randomUUID();

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function previousWeekday(date: Date): Date {
  const d = new Date(date);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return d;
}

type BreadthUniverseDef = {
  id: string;
  name: string;
  etfTicker: string;
  sourceLabel: string;
};

const LEGACY_BREADTH_UNIVERSE_ID = "sp500-lite";
const OVERALL_BREADTH_UNIVERSE_ID = "overall-market-proxy";
const NYSE_BREADTH_UNIVERSE_ID = "nyse-core";

const BREADTH_PROXY_UNIVERSES: BreadthUniverseDef[] = [
  {
    id: "sp500-core",
    name: "S&P 500",
    etfTicker: "SPY",
    sourceLabel: "SPY ETF holdings proxy (free holdings pages) + provider daily bars",
  },
  {
    id: "nasdaq-core",
    name: "NASDAQ",
    etfTicker: "QQQ",
    sourceLabel: "QQQ ETF holdings proxy (NASDAQ-100 subset) + provider daily bars",
  },
  {
    id: "russell2000-core",
    name: "Russell 2000",
    etfTicker: "IWM",
    sourceLabel: "IWM ETF holdings proxy (free holdings pages) + provider daily bars",
  },
];

type BreadthUniverseState = {
  universeTickers: Map<string, string[]>;
  sourceByUniverse: Map<string, string>;
  unavailable: Array<{ id: string; name: string; reason: string }>;
};

function isStatusStale(lastSyncedAt: string | null | undefined, maxAgeDays = 14): boolean {
  if (!lastSyncedAt) return true;
  const t = new Date(lastSyncedAt).getTime();
  if (Number.isNaN(t)) return true;
  return Date.now() - t > maxAgeDays * 86400_000;
}

async function loadConstituentTickers(env: Env, etfTicker: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT constituent_ticker as ticker FROM etf_constituents WHERE etf_ticker = ? ORDER BY constituent_ticker ASC",
  )
    .bind(etfTicker)
    .all<{ ticker: string }>();
  return Array.from(new Set((rows.results ?? []).map((r) => r.ticker.toUpperCase()).filter(Boolean)));
}

async function loadUniverseTickers(env: Env, universeId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT ticker FROM universe_symbols WHERE universe_id = ? ORDER BY ticker ASC",
  )
    .bind(universeId)
    .all<{ ticker: string }>();
  return Array.from(new Set((rows.results ?? []).map((r) => r.ticker.toUpperCase()).filter(Boolean)));
}

async function loadTickersByExchangeWithBars(env: Env, exchangeLike: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT s.ticker as ticker FROM symbols s JOIN daily_bars d ON d.ticker = s.ticker WHERE UPPER(COALESCE(s.exchange, '')) LIKE ? GROUP BY s.ticker HAVING COUNT(*) >= 2 ORDER BY s.ticker ASC",
  )
    .bind(exchangeLike.toUpperCase())
    .all<{ ticker: string }>();
  return Array.from(new Set((rows.results ?? []).map((r) => r.ticker.toUpperCase()).filter(Boolean)));
}

async function loadTickersWithBars(env: Env): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT ticker FROM daily_bars GROUP BY ticker HAVING COUNT(*) >= 2 ORDER BY ticker ASC",
  ).all<{ ticker: string }>();
  return Array.from(new Set((rows.results ?? []).map((r) => r.ticker.toUpperCase()).filter(Boolean)));
}

async function ensureUniverseMembership(env: Env, universeId: string, universeName: string, tickers: string[]): Promise<void> {
  const unique = Array.from(new Set(tickers.map((t) => t.toUpperCase()).filter(Boolean)));
  if (unique.length === 0) return;
  const statements = [
    env.DB.prepare("INSERT OR REPLACE INTO universes (id, name) VALUES (?, ?)").bind(universeId, universeName),
    env.DB.prepare("DELETE FROM universe_symbols WHERE universe_id = ?").bind(universeId),
    ...unique.map((ticker) =>
      env.DB.prepare("INSERT OR IGNORE INTO universe_symbols (universe_id, ticker) VALUES (?, ?)").bind(universeId, ticker),
    ),
  ];
  await env.DB.batch(statements);
}

async function ensureBreadthUniverseMemberships(env: Env): Promise<BreadthUniverseState> {
  const universeTickers = new Map<string, string[]>();
  const sourceByUniverse = new Map<string, string>();
  const unavailable: Array<{ id: string; name: string; reason: string }> = [];

  for (const def of BREADTH_PROXY_UNIVERSES) {
    let tickers = await loadConstituentTickers(env, def.etfTicker);
    const status = await env.DB.prepare(
      "SELECT last_synced_at as lastSyncedAt FROM etf_constituent_sync_status WHERE etf_ticker = ? LIMIT 1",
    )
      .bind(def.etfTicker)
      .first<{ lastSyncedAt: string | null }>();

    if (tickers.length === 0 || isStatusStale(status?.lastSyncedAt, 21)) {
      try {
        await syncEtfConstituents(env, def.etfTicker);
      } catch (error) {
        console.error("breadth universe constituent sync failed", { universeId: def.id, etfTicker: def.etfTicker, error });
      }
      tickers = await loadConstituentTickers(env, def.etfTicker);
    }

    if (tickers.length === 0) {
      if (def.id === "sp500-core") {
        tickers = await loadUniverseTickers(env, LEGACY_BREADTH_UNIVERSE_ID);
      } else if (def.id === "nasdaq-core") {
        tickers = await loadTickersByExchangeWithBars(env, "%NASDAQ%");
      } else if (def.id === "russell2000-core") {
        const nyseLike = await loadTickersByExchangeWithBars(env, "%NYSE%");
        const legacy = await loadUniverseTickers(env, LEGACY_BREADTH_UNIVERSE_ID);
        tickers = nyseLike.length > 0 ? nyseLike : legacy;
      }
      if (tickers.length > 0) {
        sourceByUniverse.set(def.id, `Fallback proxy from local symbols/daily bars (no ${def.etfTicker} constituent feed available)`);
      } else {
        unavailable.push({
          id: def.id,
          name: def.name,
          reason: `No free constituent data available for ${def.etfTicker} holdings and no local fallback universe was found`,
        });
        continue;
      }
    }

    await ensureUniverseMembership(env, def.id, def.name, tickers);
    universeTickers.set(def.id, tickers);
    if (!sourceByUniverse.has(def.id)) {
      sourceByUniverse.set(def.id, def.sourceLabel);
    }
  }

  const unionTickers = Array.from(new Set([...universeTickers.values()].flat()));
  if (unionTickers.length > 0) {
    await ensureUniverseMembership(env, OVERALL_BREADTH_UNIVERSE_ID, "Overall Market (Proxy)", unionTickers);
    universeTickers.set(OVERALL_BREADTH_UNIVERSE_ID, unionTickers);
    sourceByUniverse.set(
      OVERALL_BREADTH_UNIVERSE_ID,
      "Union of free proxy universes (SPY/QQQ/IWM constituent sets) + provider daily bars",
    );
  }

  let nyseTickers = await loadTickersByExchangeWithBars(env, "%NYSE%");
  if (nyseTickers.length === 0) {
    nyseTickers = await loadUniverseTickers(env, LEGACY_BREADTH_UNIVERSE_ID);
  }
  if (nyseTickers.length > 0) {
    await ensureUniverseMembership(env, NYSE_BREADTH_UNIVERSE_ID, "NYSE", nyseTickers);
    universeTickers.set(NYSE_BREADTH_UNIVERSE_ID, nyseTickers);
    sourceByUniverse.set(
      NYSE_BREADTH_UNIVERSE_ID,
      "Exchange-tagged symbols with local daily bars (NYSE proxy; falls back to SP500 proxy set when sparse)",
    );
  } else {
    unavailable.push({
      id: NYSE_BREADTH_UNIVERSE_ID,
      name: "NYSE",
      reason: "No complete free NYSE constituent feed is configured and no local fallback tickers were found",
    });
  }

  if (!universeTickers.has(OVERALL_BREADTH_UNIVERSE_ID)) {
    const allTickers = await loadTickersWithBars(env);
    if (allTickers.length > 0) {
      await ensureUniverseMembership(env, OVERALL_BREADTH_UNIVERSE_ID, "Overall Market (Proxy)", allTickers);
      universeTickers.set(OVERALL_BREADTH_UNIVERSE_ID, allTickers);
      sourceByUniverse.set(
        OVERALL_BREADTH_UNIVERSE_ID,
        "All locally available symbols with sufficient daily bars (overall free-data proxy)",
      );
    }
  }

  unavailable.push({
    id: "worden-common-stock-universe",
    name: "Overall Market (Worden Common Stock Universe)",
    reason: "Proprietary universe; no free direct feed is available",
  });

  return { universeTickers, sourceByUniverse, unavailable };
}

export async function computeAndStoreSnapshot(env: Env, asOfDateInput?: string, configId = "default"): Promise<{ snapshotId: string; asOfDate: string }> {
  const today = asOfDateInput ? new Date(`${asOfDateInput}T00:00:00Z`) : new Date();
  const asOfDate = toISODate(previousWeekday(today));
  const config = await loadConfig(env, configId);
  let providerLabel = "Stored Daily Bars";
  const provider = (() => {
    try {
      const p = getProvider(env);
      providerLabel = p.label;
      return p;
    } catch (error) {
      console.error("provider init failed, using stored bars only", error);
      return null;
    }
  })();

  const dashboardTickers = Array.from(
    new Set(
      config.sections
        .flatMap((s) => s.groups)
        .flatMap((g) => g.items)
        .filter((it) => it.enabled)
        .map((it) => it.ticker),
    ),
  );
  const breadthState = await (async (): Promise<BreadthUniverseState> => {
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
  })();
  const breadthTickers = Array.from(new Set([...breadthState.universeTickers.values()].flat()));
  const tickers = Array.from(new Set([...dashboardTickers, ...breadthTickers]));

  const endDate = asOfDate;
  const startDate = toISODate(new Date(new Date(`${asOfDate}T00:00:00Z`).getTime() - 420 * 86400_000));
  if (provider) {
    try {
      const freshBars = await provider.getDailyBars(tickers, startDate, endDate);
      if (freshBars.length > 0) {
        const stmts = freshBars.map((b) =>
          env.DB.prepare(
            "INSERT OR REPLACE INTO daily_bars (ticker, date, o, h, l, c, volume) VALUES (?, ?, ?, ?, ?, ?, ?)",
          ).bind(b.ticker, b.date, b.o, b.h, b.l, b.c, b.volume),
        );
        await env.DB.batch(stmts);
      }
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

  const snapshotId = uid();
  await env.DB.prepare(
    "INSERT OR REPLACE INTO snapshots_meta (id, config_id, as_of_date, generated_at, provider_label) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(snapshotId, configId, asOfDate, new Date().toISOString(), providerLabel)
    .run();

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
  if (rowInserts.length > 0) await env.DB.batch(rowInserts);
  const breadthUniverseIds = Array.from(
    new Set<string>([...breadthState.universeTickers.keys(), LEGACY_BREADTH_UNIVERSE_ID]),
  );
  for (const universeId of breadthUniverseIds) {
    await computeAndStoreBreadth(env, asOfDate, universeId, breadthState.sourceByUniverse.get(universeId) ?? null);
  }
  return { snapshotId, asOfDate };
}

export async function computeAndStoreBreadth(
  env: Env,
  asOfDate: string,
  universeId: string,
  dataSource: string | null = null,
): Promise<void> {
  const members = await env.DB.prepare("SELECT ticker FROM universe_symbols WHERE universe_id = ?")
    .bind(universeId)
    .all<{ ticker: string }>();
  const tickers = (members.results ?? []).map((r) => r.ticker);
  if (tickers.length === 0) return;
  const allRows = await env.DB.prepare(
    "SELECT ticker, date, c, volume FROM daily_bars WHERE ticker IN (SELECT ticker FROM universe_symbols WHERE universe_id = ?) AND date <= ? ORDER BY ticker, date",
  )
    .bind(universeId, asOfDate)
    .all<{ ticker: string; date: string; c: number; volume: number | null }>();

  const barsByTicker = new Map<string, { closes: number[]; volumes: number[] }>();
  for (const r of allRows.results ?? []) {
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
  const id = `${asOfDate}:${universeId}`;
  await env.DB.prepare(
    "INSERT OR REPLACE INTO breadth_snapshots (id, as_of_date, universe_id, advancers, decliners, unchanged, pct_above_20ma, pct_above_50ma, pct_above_200ma, new_20d_highs, new_20d_lows, median_return_1d, median_return_5d, sentiment_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
    )
    .run();
}

export async function loadSnapshot(env: Env, configId = "default", requestedDate?: string): Promise<SnapshotResponse> {
  const config = await loadConfig(env, configId);
  const meta = requestedDate
    ? await env.DB.prepare(
        "SELECT id, as_of_date as asOfDate, generated_at as generatedAt, provider_label as providerLabel FROM snapshots_meta WHERE config_id = ? AND as_of_date = ?",
      )
        .bind(configId, requestedDate)
        .first<{ id: string; asOfDate: string; generatedAt: string; providerLabel: string }>()
    : await env.DB.prepare(
        "SELECT id, as_of_date as asOfDate, generated_at as generatedAt, provider_label as providerLabel FROM snapshots_meta WHERE config_id = ? ORDER BY as_of_date DESC LIMIT 1",
      )
        .bind(configId)
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
            rankKey: r.rankKey,
            holdings: r.holdingsJson ? (JSON.parse(r.holdingsJson) as string[]) : null,
          })),
      })),
    })),
  };
}
