import { CORE_BREADTH_UNIVERSE_IDS, minBreadthCoveragePct } from "./eod";
import { isBreadthUniverseMemberCountValid } from "./breadth-quality";
import { getMarketDataDb } from "./market-data-db";
import { latestUsMarketSessionAsOfDate } from "./market-calendar";
import type { Env } from "./types";

const PROVIDER_LABEL = "Alpaca SIP split-adjusted completed daily bars; Alpaca IEX exact-session fallback.";

const UNIVERSE_NAMES: Record<string, string> = {
  "sp500-core": "S&P 500",
  "nasdaq-core": "NASDAQ",
  "nyse-core": "NYSE",
  "russell2000-core": "Russell 2000 — IWM holdings proxy",
  "overall-market-proxy": "Overall Market Proxy",
};

type SnapshotRow = {
  asOfDate: string;
  universeId: string;
  advancers: number;
  decliners: number;
  unchanged: number;
  pctAbove20MA: number | null;
  pctAbove50MA: number | null;
  pctAbove200MA: number | null;
  new20DHighs: number | null;
  new20DLows: number | null;
  medianReturn1D: number;
  medianReturn5D: number | null;
  sentimentJson: string | null;
  generatedAt: string;
  generationId: string | null;
  publishedGenerationId: string | null;
  publishedAsOfDate: string | null;
  publishedGeneratedAt: string | null;
  publishedProviderLabel: string | null;
};

type UniverseRow = {
  universeId: string;
  universeName: string;
  memberCount: number;
  versionId: string | null;
  source: string | null;
  sourceType: string | null;
  sourceUrl: string | null;
  sourceAsOfDate: string | null;
  sourceMemberCount: number | null;
  resolvedMemberCount: number | null;
  unresolvedCount: number | null;
  validationError: string | null;
};

type ReadinessRow = {
  scope: string;
  expectedAsOfDate: string | null;
  sourceAsOfDate: string | null;
  status: string;
  coveragePct: number | null;
  warning: string | null;
  updatedAt: string;
};

function parseSentiment(raw: string | null): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw ?? "{}");
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function numeric(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function publicSnapshot(row: SnapshotRow) {
  const sentiment = parseSentiment(row.sentimentJson);
  return {
    asOfDate: row.asOfDate,
    universeId: row.universeId,
    advancers: row.advancers,
    decliners: row.decliners,
    unchanged: row.unchanged,
    pctAbove20MA: row.pctAbove20MA,
    pctAbove50MA: row.pctAbove50MA,
    pctAbove200MA: row.pctAbove200MA,
    new20DHighs: row.new20DHighs,
    new20DLows: row.new20DLows,
    medianReturn1D: row.medianReturn1D,
    medianReturn5D: row.medianReturn5D,
    generatedAt: row.generatedAt,
    metrics: sentiment.metrics ?? null,
    dataSource: sentiment.dataSource ?? null,
    provenance: sentiment.provenance ?? null,
    sourceMix: sentiment.sourceMix ?? null,
  };
}

export type BreadthDashboardResponse = Awaited<ReturnType<typeof loadBreadthDashboard>>;

export async function loadBreadthDashboard(
  env: Env,
  historyLimitInput = 120,
  now = new Date(),
) {
  const db = getMarketDataDb(env);
  const historyLimit = Math.max(1, Math.min(450, Math.trunc(historyLimitInput) || 120));
  const expectedAsOfSession = latestUsMarketSessionAsOfDate(now);
  const idsJson = JSON.stringify(CORE_BREADTH_UNIVERSE_IDS);

  // Statement 1: every bounded history and the atomic published pointer.
  const snapshotResult = await db.prepare(
    `WITH published AS (
       SELECT g.id, g.as_of_date, g.generated_at, g.provider_label
         FROM breadth_publication_pointer p
         JOIN breadth_generations g ON g.id = p.generation_id
        WHERE p.pointer_key = 'default' AND g.status = 'published'
        LIMIT 1
     ), ranked AS (
       SELECT b.*,
              ROW_NUMBER() OVER (PARTITION BY b.universe_id ORDER BY b.as_of_date DESC, b.generated_at DESC) AS row_num
         FROM breadth_snapshots b
         JOIN breadth_generations generation
           ON generation.id = b.generation_id
          AND generation.status = 'published'
        WHERE b.universe_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
     )
     SELECT r.as_of_date as asOfDate, r.universe_id as universeId,
            r.advancers, r.decliners, r.unchanged,
            r.pct_above_20ma as pctAbove20MA, r.pct_above_50ma as pctAbove50MA,
            r.pct_above_200ma as pctAbove200MA, r.new_20d_highs as new20DHighs,
            r.new_20d_lows as new20DLows, r.median_return_1d as medianReturn1D,
            r.median_return_5d as medianReturn5D, r.sentiment_json as sentimentJson,
            r.generated_at as generatedAt, r.generation_id as generationId,
            p.id as publishedGenerationId, p.as_of_date as publishedAsOfDate,
            p.generated_at as publishedGeneratedAt, p.provider_label as publishedProviderLabel
       FROM ranked r LEFT JOIN published p ON 1 = 1
      WHERE r.row_num <= ?
      ORDER BY r.universe_id, r.as_of_date DESC`,
  ).bind(idsJson, historyLimit).all<SnapshotRow>();

  // Statement 2: promoted membership and source provenance for every universe.
  const universeResult = await db.prepare(
    `SELECT u.id as universeId, u.name as universeName,
            COUNT(uvm.ticker) as memberCount, uv.id as versionId,
            uv.source, uv.source_type as sourceType, uv.source_url as sourceUrl,
            uv.source_as_of_date as sourceAsOfDate,
            uv.source_member_count as sourceMemberCount,
            uv.resolved_member_count as resolvedMemberCount,
            uv.unresolved_count as unresolvedCount,
            uv.validation_error as validationError
       FROM universes u
       LEFT JOIN universe_versions uv ON uv.id = u.active_version_id
       LEFT JOIN universe_version_members uvm ON uvm.version_id = uv.id
      WHERE u.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
      GROUP BY u.id, u.name, uv.id`,
  ).bind(idsJson).all<UniverseRow>();

  // Statement 3: concrete failure/coverage state from the last candidate.
  const readinessResult = await db.prepare(
    `SELECT scope, expected_as_of_date as expectedAsOfDate,
            source_as_of_date as sourceAsOfDate, status, coverage_pct as coveragePct,
            warning, updated_at as updatedAt
       FROM data_readiness
      WHERE domain = 'breadth'
        AND scope IN (SELECT CAST(value AS TEXT) FROM json_each(?))`,
  ).bind(idsJson).all<ReadinessRow>();

  // Statement 4: the bounded calendar makes stale age holiday-aware.
  const sessionResult = await db.prepare(
    `SELECT session_date as sessionDate
       FROM market_calendar_sessions
      WHERE session_date <= ?
      ORDER BY session_date DESC
      LIMIT 450`,
  ).bind(expectedAsOfSession).all<{ sessionDate: string }>();

  const sessions = (sessionResult.results ?? []).map((row) => row.sessionDate);
  const historyByUniverse = new Map<string, SnapshotRow[]>();
  for (const row of snapshotResult.results ?? []) {
    const rows = historyByUniverse.get(row.universeId) ?? [];
    rows.push(row);
    historyByUniverse.set(row.universeId, rows);
  }
  const universeById = new Map((universeResult.results ?? []).map((row) => [row.universeId, row]));
  const readinessById = new Map((readinessResult.results ?? []).map((row) => [row.scope, row]));
  const pointerRow = (snapshotResult.results ?? [])[0] ?? null;
  const publishedAsOfDate = pointerRow?.publishedAsOfDate ?? null;
  const generationId = pointerRow?.publishedGenerationId ?? null;

  const universes = CORE_BREADTH_UNIVERSE_IDS.map((universeId) => {
    const historyDesc = historyByUniverse.get(universeId) ?? [];
    const displayed = (publishedAsOfDate
      ? historyDesc.find((row) => row.asOfDate === publishedAsOfDate)
      : historyDesc[0]) ?? null;
    const membership = universeById.get(universeId) ?? null;
    const readiness = readinessById.get(universeId) ?? null;
    const sentiment = displayed ? parseSentiment(displayed.sentimentJson) : {};
    const metrics = sentiment.metrics && typeof sentiment.metrics === "object"
      ? sentiment.metrics as Record<string, unknown>
      : {};
    const sourceMix = sentiment.sourceMix && typeof sentiment.sourceMix === "object"
      ? sentiment.sourceMix as Record<string, unknown>
      : {};
    const memberCount = numeric(membership?.memberCount, numeric(metrics.totalUniverseMembers));
    const eligibleCount = numeric(metrics.memberCount, displayed ? displayed.advancers + displayed.decliners + displayed.unchanged : 0);
    const unsupportedCount = numeric(membership?.unresolvedCount);
    const exactSessionCount = eligibleCount;
    const repairSourceCount = numeric(sourceMix.yahoo);
    const coveragePct = memberCount > 0 ? (eligibleCount / memberCount) * 100 : 0;
    const requiredCoveragePct = minBreadthCoveragePct(universeId);
    const staleTradingSessions = displayed
      ? sessions.filter((session) => session > displayed.asOfDate && session <= expectedAsOfSession).length
      : 0;
    const isFallback = displayed?.asOfDate !== expectedAsOfSession;
    let freshness: "fresh" | "stale" | "low_coverage" | "missing" = "fresh";
    let errorCode: string | null = null;
    let errorMessage: string | null = null;
    if (!displayed) {
      freshness = "missing";
      errorCode = "breadth-generation-missing";
      errorMessage = "No validated Breadth generation is stored for this universe.";
    } else if (!isBreadthUniverseMemberCountValid(universeId, memberCount)) {
      freshness = "low_coverage";
      errorCode = "universe-membership-invalid";
      errorMessage = `The active ${universeId} membership contains ${memberCount} members and is outside its validated range.`;
    } else if (coveragePct < requiredCoveragePct || readiness?.status === "blocked") {
      freshness = "low_coverage";
      errorCode = repairSourceCount > 0 && numeric(sentiment.repairedPct) > 5
        ? "repair-source-limit"
        : "breadth-coverage-below-threshold";
      errorMessage = readiness?.warning ?? `Coverage ${coveragePct.toFixed(1)}% is below the ${requiredCoveragePct}% publication threshold.`;
    } else if (isFallback) {
      freshness = "stale";
      errorCode = readiness?.status === "blocked" ? "breadth-publication-blocked" : "breadth-generation-stale";
      errorMessage = readiness?.warning ?? `Displaying the last validated ${displayed.asOfDate} generation because ${expectedAsOfSession} has not passed publication validation.`;
    }
    return {
      universeId,
      universeName: membership?.universeName ?? UNIVERSE_NAMES[universeId] ?? universeId,
      displayedSnapshot: displayed ? publicSnapshot(displayed) : null,
      displayedAsOfSession: displayed?.asOfDate ?? null,
      isFallback,
      freshness,
      staleTradingSessions,
      memberCount,
      exactSessionCount,
      eligibleCount,
      unsupportedCount,
      repairSourceCount,
      coveragePct,
      requiredCoveragePct,
      membership: {
        versionId: membership?.versionId ?? null,
        source: membership?.source ?? null,
        sourceType: membership?.sourceType ?? null,
        sourceUrl: membership?.sourceUrl ?? null,
        sourceAsOfDate: membership?.sourceAsOfDate ?? null,
        status: membership?.validationError ? "invalid" : membership?.versionId ? "active" : "missing",
      },
      error: errorCode ? { code: errorCode, message: errorMessage ?? errorCode } : null,
      history: [...historyDesc].reverse().map(publicSnapshot),
    };
  });
  const problemRows = universes.filter((universe) => universe.freshness !== "fresh");
  const overallHealth = problemRows.length === 0
    ? "fresh"
    : problemRows.length === universes.length
      ? "stale"
      : "partial";
  return {
    generationId,
    generatedAt: pointerRow?.publishedGeneratedAt ?? null,
    expectedAsOfSession,
    providerLabel: pointerRow?.publishedProviderLabel ?? PROVIDER_LABEL,
    overallHealth,
    warning: problemRows.length
      ? `${problemRows.length} of ${universes.length} Breadth universes are not current for ${expectedAsOfSession}.`
      : null,
    universes,
  };
}
