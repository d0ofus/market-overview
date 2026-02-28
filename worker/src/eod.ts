import { computeBreadthStats, computeMetrics, rankValue } from "./metrics";
import { loadConfig } from "./db";
import { getProvider } from "./provider";
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

  const tickers = Array.from(
    new Set(
      config.sections
        .flatMap((s) => s.groups)
        .flatMap((g) => g.items)
        .filter((it) => it.enabled)
        .map((it) => it.ticker),
    ),
  );

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
  await computeAndStoreBreadth(env, asOfDate, "sp500-lite");
  return { snapshotId, asOfDate };
}

export async function computeAndStoreBreadth(env: Env, asOfDate: string, universeId: string): Promise<void> {
  const members = await env.DB.prepare("SELECT ticker FROM universe_symbols WHERE universe_id = ?")
    .bind(universeId)
    .all<{ ticker: string }>();
  const tickers = (members.results ?? []).map((r) => r.ticker);
  const allRows = await env.DB.prepare(
    "SELECT ticker, date, c FROM daily_bars WHERE ticker IN (SELECT ticker FROM universe_symbols WHERE universe_id = ?) AND date <= ? ORDER BY ticker, date",
  )
    .bind(universeId, asOfDate)
    .all<{ ticker: string; date: string; c: number }>();

  const barsByTicker = new Map<string, number[]>();
  for (const r of allRows.results ?? []) {
    const v = barsByTicker.get(r.ticker) ?? [];
    v.push(r.c);
    barsByTicker.set(r.ticker, v);
  }

  const stats = computeBreadthStats(
    Object.fromEntries(tickers.map((t) => [t, barsByTicker.get(t) ?? []])),
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
      JSON.stringify({ fearGreed: null, putCall: null }),
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
