import { EQUAL_WEIGHT_SECTOR_ETFS } from "./etf-catalog";
import type { Env } from "./types";

const DEFAULT_CONFIG_ID = "default";
const EQUAL_WEIGHT_GROUP_ID = "g-sector-etf-eqwt";
const REQUIRED_THREE_MONTH_POINTS = 63;
const MATURE_SPARKLINE_CANDIDATES: Array<{ ticker: string; groupId: string }> = [
  { ticker: "AAPL", groupId: "g-market-leaders" },
  { ticker: "SPY", groupId: "g-us-index" },
];

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

  for (const candidate of MATURE_SPARKLINE_CANDIDATES) {
    const row = await env.DB.prepare(
      "SELECT sparkline_json as sparklineJson FROM snapshot_rows WHERE snapshot_id = ? AND group_id = ? AND ticker = ? LIMIT 1",
    ).bind(latest.id, candidate.groupId, candidate.ticker).first<{ sparklineJson: string | null }>();
    const length = parseSparklineLength(row?.sparklineJson);
    if (length != null && length < REQUIRED_THREE_MONTH_POINTS) return true;
    if (length != null) return false;
  }

  return false;
}
