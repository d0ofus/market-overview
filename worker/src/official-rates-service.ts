import type { Env } from "./types";
import { fetchWithTimeout } from "./timeout";

export const OFFICIAL_EFFR_API = "https://markets.newyorkfed.org/api/rates/unsecured/effr/last/1.json";
export type OfficialRateFacts = {
  source: "Federal Reserve Bank of New York";
  sourceUrl: string;
  effectiveDate: string;
  fetchedAt: string;
  effr: number;
  targetLower: number | null;
  targetUpper: number | null;
};
export type OfficialRatesResult = { officialRates: OfficialRateFacts | null; officialRatesWarning: string | null };

export function normalizeOfficialRates(payload: unknown, fetchedAt: string): OfficialRateFacts | null {
  const rows = (payload as { refRates?: Array<Record<string, unknown>> } | null)?.refRates;
  if (!Array.isArray(rows)) return null;
  const row = rows.find((entry) => entry.type === "EFFR");
  if (!row || typeof row.effectiveDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.effectiveDate)
    || !Number.isFinite(Date.parse(row.effectiveDate)) || row.effectiveDate > fetchedAt.slice(0, 10)
    || typeof row.percentRate !== "number" || !Number.isFinite(row.percentRate)) return null;
  const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
  const lower = number(row.targetRateFrom);
  const upper = number(row.targetRateTo);
  return {
    source: "Federal Reserve Bank of New York",
    sourceUrl: "https://www.newyorkfed.org/markets/reference-rates/effr",
    effectiveDate: row.effectiveDate,
    fetchedAt,
    effr: row.percentRate,
    targetLower: lower != null && upper != null && lower <= upper ? lower : null,
    targetUpper: lower != null && upper != null && lower <= upper ? upper : null,
  };
}

export async function loadOfficialRateFacts(env: Env): Promise<OfficialRatesResult> {
  try {
    const row = await env.DB.prepare("SELECT data_json as dataJson, last_error as lastError FROM official_rate_snapshots WHERE source = 'nyfed-effr'")
      .first<{ dataJson: string; lastError: string | null }>();
    if (!row) return { officialRates: null, officialRatesWarning: "Official New York Fed rate facts have not been cached yet." };
    const officialRates = JSON.parse(row.dataJson) as OfficialRateFacts;
    return { officialRates, officialRatesWarning: row.lastError
      ? `Last official-rate refresh failed; showing facts effective ${officialRates.effectiveDate}. ${row.lastError}`
      : Date.now() - Date.parse(officialRates.fetchedAt) > 36 * 60 * 60_000
        ? `Official rate facts were last checked ${officialRates.fetchedAt}; effective ${officialRates.effectiveDate}.`
        : null };
  } catch {
    return { officialRates: null, officialRatesWarning: "Stored official rate facts are unavailable." };
  }
}

export async function refreshOfficialRateFacts(env: Env): Promise<OfficialRatesResult> {
  const nowIso = new Date().toISOString();
  try {
    const response = await fetchWithTimeout(OFFICIAL_EFFR_API, { headers: { Accept: "application/json" } }, 15_000);
    if (!response.ok) throw new Error(`New York Fed rate request failed (${response.status}).`);
    const officialRates = normalizeOfficialRates(await response.json(), nowIso);
    if (!officialRates) throw new Error("New York Fed returned no valid EFFR observation.");
    await env.DB.prepare(`INSERT INTO official_rate_snapshots (source, effective_date, fetched_at, data_json, last_attempt_at, last_error)
      VALUES ('nyfed-effr', ?, ?, ?, ?, NULL) ON CONFLICT(source) DO UPDATE SET effective_date = excluded.effective_date,
      fetched_at = excluded.fetched_at, data_json = excluded.data_json, last_attempt_at = excluded.last_attempt_at, last_error = NULL`)
      .bind(officialRates.effectiveDate, nowIso, JSON.stringify(officialRates), nowIso).run();
    return { officialRates, officialRatesWarning: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Official rate refresh failed.";
    await env.DB.prepare("UPDATE official_rate_snapshots SET last_attempt_at = ?, last_error = ? WHERE source = 'nyfed-effr'")
      .bind(nowIso, message).run().catch(() => undefined);
    const stored = await loadOfficialRateFacts(env);
    return { ...stored, officialRatesWarning: message };
  }
}
