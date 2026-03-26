import { EQUAL_WEIGHT_SECTOR_ETFS } from "./etf-catalog";
import { sanitizeBarSeries } from "./metrics";
import type { Env } from "./types";

const DEFAULT_CONFIG_ID = "default";
const EQUAL_WEIGHT_GROUP_ID = "g-sector-etf-eqwt";
const SPARKLINE_LOOKBACK_POINTS = 90;

function parseSparklineValues(raw: string | null | undefined): number[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.every((value) => typeof value === "number" && Number.isFinite(value))
      ? parsed as number[]
      : null;
  } catch {
    return null;
  }
}

export async function isOverviewSnapshotStale(env: Env, configId = DEFAULT_CONFIG_ID): Promise<boolean> {
  const latest = await env.DB.prepare(
    "SELECT id, as_of_date as asOfDate FROM snapshots_meta WHERE config_id = ? ORDER BY as_of_date DESC, datetime(generated_at) DESC LIMIT 1",
  ).bind(configId).first<{ id: string; asOfDate: string }>();
  if (!latest?.id) return false;

  const expectedEqualWeightNames = new Map(
    EQUAL_WEIGHT_SECTOR_ETFS.map((row) => [row.ticker.toUpperCase(), row.instrumentName]),
  );
  const equalWeightRows = await env.DB.prepare(
    "SELECT ticker, display_name as displayName FROM snapshot_rows WHERE snapshot_id = ? AND group_id = ?",
  ).bind(latest.id, EQUAL_WEIGHT_GROUP_ID).all<{ ticker: string; displayName: string | null }>();

  for (const row of equalWeightRows.results ?? []) {
    const expected = expectedEqualWeightNames.get(row.ticker.toUpperCase());
    if (expected && row.displayName !== expected) return true;
  }

  const sparklineRows = await env.DB.prepare(
    `SELECT sr.group_id as groupId, sr.ticker, sr.sparkline_json as sparklineJson
     FROM snapshot_rows sr
     JOIN dashboard_groups dg ON dg.id = sr.group_id
     JOIN dashboard_sections ds ON ds.id = dg.section_id
     WHERE sr.snapshot_id = ?
       AND ds.config_id = ?
       AND dg.show_sparkline = 1
       AND (ds.title LIKE '%Macro%' OR ds.title LIKE '%Equities%')`,
  ).bind(latest.id, configId).all<{ groupId: string; ticker: string; sparklineJson: string | null }>();

  const uniqueTickers = Array.from(new Set((sparklineRows.results ?? []).map((row) => row.ticker.toUpperCase()).filter(Boolean)));
  const seriesByTicker = new Map<string, { dates: string[]; closes: number[] }>();
  if (uniqueTickers.length > 0) {
    const placeholders = uniqueTickers.map(() => "?").join(", ");
    const bars = await env.DB.prepare(
      `SELECT ticker, date, c
       FROM daily_bars
       WHERE ticker IN (${placeholders}) AND date <= ?
       ORDER BY ticker, date`,
    ).bind(...uniqueTickers, latest.asOfDate).all<{ ticker: string; date: string; c: number }>();
    for (const row of bars.results ?? []) {
      const ticker = row.ticker.toUpperCase();
      const series = seriesByTicker.get(ticker) ?? { dates: [], closes: [] };
      series.dates.push(row.date);
      series.closes.push(row.c);
      seriesByTicker.set(ticker, series);
    }
  }

  for (const row of sparklineRows.results ?? []) {
    const values = parseSparklineValues(row.sparklineJson);
    const rawSeries = seriesByTicker.get(row.ticker.toUpperCase()) ?? { dates: [], closes: [] };
    const cleanedSeries = sanitizeBarSeries(rawSeries.dates, rawSeries.closes);
    const expectedValues = cleanedSeries.closes.slice(Math.max(0, cleanedSeries.closes.length - SPARKLINE_LOOKBACK_POINTS));
    if (values == null) return true;
    if (values.length !== expectedValues.length) return true;
    if (values.some((value, index) => Math.abs(value - expectedValues[index]) > 0.000001)) return true;
  }

  return false;
}
