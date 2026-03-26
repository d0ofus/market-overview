import { EQUAL_WEIGHT_SECTOR_ETFS } from "./etf-catalog";
import type { Env } from "./types";

const DEFAULT_CONFIG_ID = "default";
const EQUAL_WEIGHT_GROUP_ID = "g-sector-etf-eqwt";

function parseSparklineLength(raw: string | null | undefined): number | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.length : null;
  } catch {
    return null;
  }
}

export async function isOverviewSnapshotStale(env: Env, configId = DEFAULT_CONFIG_ID): Promise<boolean> {
  const latest = await env.DB.prepare(
    "SELECT id FROM snapshots_meta WHERE config_id = ? ORDER BY as_of_date DESC, datetime(generated_at) DESC LIMIT 1",
  ).bind(configId).first<{ id: string }>();
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

  for (const row of sparklineRows.results ?? []) {
    const length = parseSparklineLength(row.sparklineJson);
    if (length == null) return true;
  }

  return false;
}
