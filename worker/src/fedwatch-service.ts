import type { Env } from "./types";

const RATE_PROBABILITY_API_URL = "https://rateprobability.com/api/latest";
const RATE_PROBABILITY_SOURCE_URL = "https://rateprobability.com/fed";
const SNAPSHOT_RETENTION_DAYS = 14;
const SNAPSHOT_FRESH_MS = 60 * 60_000;

type RateProbabilityApiRow = {
  meeting?: string;
  meeting_iso?: string;
  implied_rate_post_meeting?: number;
  prob_move_pct?: number;
  prob_is_cut?: boolean;
  num_moves?: number;
  num_moves_is_cut?: boolean;
  change_bps?: number;
};

type RateProbabilityApiComparisonRow = {
  meeting?: string;
  meeting_iso?: string;
  implied?: number;
};

type RateProbabilityApiComparison = {
  rows?: RateProbabilityApiComparisonRow[];
  used_date?: string;
  effr?: number;
  label?: string;
};

type RateProbabilityApiPayload = {
  today?: {
    as_of?: string;
    "current band"?: string;
    midpoint?: number;
    most_recent_effr?: number;
    assumed_move_bps?: number;
    rows?: RateProbabilityApiRow[];
  };
  ago_1w?: RateProbabilityApiComparison;
  ago_3w?: RateProbabilityApiComparison;
  ago_6w?: RateProbabilityApiComparison;
  ago_10w?: RateProbabilityApiComparison;
};

type StoredFedWatchSnapshotRow = {
  id: string;
  generatedAt: string;
  sourceUrl: string;
  currentTargetRange: string | null;
  dataJson: string;
};

export type FedFundsPathRow = {
  meeting: string;
  meetingIso: string;
  impliedRatePostMeeting: number;
  probMovePct: number;
  probIsCut: boolean;
  numMoves: number;
  numMovesIsCut: boolean;
  changeBps: number;
};

export type FedFundsComparisonSeries = {
  key: "ago_1w" | "ago_3w" | "ago_6w" | "ago_10w";
  label: string;
  usedDate: string | null;
  effr: number | null;
  rows: Array<{
    meeting: string;
    meetingIso: string;
    implied: number;
  }>;
};

export type FedWatchData = {
  generatedAt: string;
  sourceUrl: string;
  asOf: string | null;
  currentBand: string | null;
  midpoint: number | null;
  mostRecentEffr: number | null;
  assumedMoveBps: number | null;
  rows: FedFundsPathRow[];
  comparisons: FedFundsComparisonSeries[];
};

export type FedWatchResponse = {
  status: "ok" | "stale" | "unavailable";
  warning: string | null;
  data: FedWatchData | null;
};

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseTodayRow(row: RateProbabilityApiRow): FedFundsPathRow | null {
  const meeting = String(row.meeting ?? "").trim();
  const meetingIso = String(row.meeting_iso ?? "").trim();
  const impliedRatePostMeeting = asNumber(row.implied_rate_post_meeting);
  const probMovePct = asNumber(row.prob_move_pct);
  const numMoves = asNumber(row.num_moves);
  const changeBps = asNumber(row.change_bps);
  if (!meeting || !meetingIso || impliedRatePostMeeting == null || probMovePct == null || numMoves == null || changeBps == null) {
    return null;
  }
  return {
    meeting,
    meetingIso,
    impliedRatePostMeeting,
    probMovePct,
    probIsCut: row.prob_is_cut === true,
    numMoves,
    numMovesIsCut: row.num_moves_is_cut === true,
    changeBps,
  };
}

function parseComparisonRows(rows: RateProbabilityApiComparisonRow[] | undefined): FedFundsComparisonSeries["rows"] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      const meeting = String(row.meeting ?? "").trim();
      const meetingIso = String(row.meeting_iso ?? "").trim();
      const implied = asNumber(row.implied);
      if (!meeting || !meetingIso || implied == null) return null;
      return { meeting, meetingIso, implied };
    })
    .filter((value): value is FedFundsComparisonSeries["rows"][number] => Boolean(value));
}

function normalizeComparison(
  key: FedFundsComparisonSeries["key"],
  comparison: RateProbabilityApiComparison | undefined,
): FedFundsComparisonSeries | null {
  const rows = parseComparisonRows(comparison?.rows);
  if (rows.length === 0) return null;
  return {
    key,
    label: String(comparison?.label ?? key).trim(),
    usedDate: typeof comparison?.used_date === "string" ? comparison.used_date : null,
    effr: asNumber(comparison?.effr),
    rows,
  };
}

export function normalizeRateProbabilityPayload(
  payload: RateProbabilityApiPayload,
  generatedAt = new Date().toISOString(),
): FedWatchData | null {
  const today = payload.today;
  const rows = (today?.rows ?? [])
    .map((row) => parseTodayRow(row))
    .filter((value): value is FedFundsPathRow => Boolean(value));
  if (rows.length === 0) return null;

  const comparisons = [
    normalizeComparison("ago_1w", payload.ago_1w),
    normalizeComparison("ago_3w", payload.ago_3w),
    normalizeComparison("ago_6w", payload.ago_6w),
    normalizeComparison("ago_10w", payload.ago_10w),
  ].filter((value): value is FedFundsComparisonSeries => Boolean(value));

  return {
    generatedAt,
    sourceUrl: RATE_PROBABILITY_SOURCE_URL,
    asOf: typeof today?.as_of === "string" ? today.as_of : null,
    currentBand: typeof today?.["current band"] === "string" ? today["current band"] : null,
    midpoint: asNumber(today?.midpoint),
    mostRecentEffr: asNumber(today?.most_recent_effr),
    assumedMoveBps: asNumber(today?.assumed_move_bps),
    rows,
    comparisons,
  };
}

async function fetchLiveFedFundsData(): Promise<FedWatchData> {
  const response = await fetch(RATE_PROBABILITY_API_URL, {
    headers: {
      "User-Agent": "market-command-centre/1.0",
      "Accept": "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`RateProbability request failed (${response.status})`);
  }
  const payload = await response.json() as RateProbabilityApiPayload;
  const parsed = normalizeRateProbabilityPayload(payload, new Date().toISOString());
  if (!parsed) {
    throw new Error("RateProbability returned JSON, but the payload was missing required Fed funds path data.");
  }
  return parsed;
}

function parseStoredData(raw: string): FedWatchData | null {
  try {
    const parsed = JSON.parse(raw) as FedWatchData | null;
    return parsed?.rows?.length ? parsed : null;
  } catch {
    return null;
  }
}

async function loadLatestStoredSnapshot(env: Env): Promise<FedWatchData | null> {
  const row = await env.DB.prepare(
    "SELECT id, generated_at as generatedAt, source_url as sourceUrl, current_target_range as currentTargetRange, data_json as dataJson FROM fedwatch_snapshots ORDER BY datetime(generated_at) DESC LIMIT 1",
  ).first<StoredFedWatchSnapshotRow>();
  if (!row?.dataJson) return null;
  const parsed = parseStoredData(row.dataJson);
  if (!parsed) return null;
  return {
    ...parsed,
    generatedAt: row.generatedAt ?? parsed.generatedAt,
    sourceUrl: row.sourceUrl ?? parsed.sourceUrl,
    currentBand: row.currentTargetRange ?? parsed.currentBand ?? null,
  };
}

function isSnapshotFresh(generatedAt: string, now = Date.now()): boolean {
  const parsed = Date.parse(generatedAt);
  if (!Number.isFinite(parsed)) return false;
  return now - parsed < SNAPSHOT_FRESH_MS;
}

async function persistSnapshot(env: Env, data: FedWatchData): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO fedwatch_snapshots (id, generated_at, source_url, current_target_range, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(
    crypto.randomUUID(),
    data.generatedAt,
    data.sourceUrl,
    data.currentBand,
    JSON.stringify(data),
    data.generatedAt,
  ).run();
}

async function cleanupOldSnapshots(env: Env, retentionDays = SNAPSHOT_RETENTION_DAYS): Promise<void> {
  await env.DB.prepare("DELETE FROM fedwatch_snapshots WHERE datetime(generated_at) < datetime('now', ?)")
    .bind(`-${Math.max(1, retentionDays)} day`)
    .run();
}

export async function getFedWatchSnapshot(env: Env, options?: { force?: boolean }): Promise<FedWatchResponse> {
  const cached = await loadLatestStoredSnapshot(env);
  if (!options?.force && cached && isSnapshotFresh(cached.generatedAt)) {
    return { status: "ok", warning: null, data: cached };
  }

  try {
    const live = await fetchLiveFedFundsData();
    await persistSnapshot(env, live);
    await cleanupOldSnapshots(env, SNAPSHOT_RETENTION_DAYS);
    return { status: "ok", warning: null, data: live };
  } catch (error) {
    const message = error instanceof Error ? error.message : "RateProbability fetch failed.";
    if (cached) {
      return {
        status: "stale",
        warning: `Showing the last successful RateProbability snapshot because the live API could not be refreshed. ${message}`,
        data: cached,
      };
    }
    return {
      status: "unavailable",
      warning: `Fed funds pricing data is temporarily unavailable from RateProbability. ${message}`,
      data: null,
    };
  }
}

export async function refreshFedWatchSnapshot(env: Env): Promise<FedWatchResponse> {
  return await getFedWatchSnapshot(env, { force: true });
}

export { isSnapshotFresh };
