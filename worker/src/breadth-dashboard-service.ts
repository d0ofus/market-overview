import { CORE_BREADTH_UNIVERSE_IDS, minBreadthCoveragePct } from "./eod";
import { isBreadthUniverseMemberCountValid } from "./breadth-quality";
import { getMarketDataDb } from "./market-data-db";
import { countUsMarketTradingSessionsAfter, latestUsMarketSessionAsOfDate } from "./market-calendar";
import { expectedEodSession } from "./eod-coordinator";
import { decodeEodPayload, type EodStoredPayload } from "./eod-publication-codec";
import { EOD_METRICS_VERSION } from "./eod-metrics";
import type { Env } from "./types";
import { zonedParts } from "./refresh-timing";

const PROVIDER_LABEL = "Split-adjusted daily prices: Alpaca SIP, coherent Yahoo fallback; reported volume: Alpaca SIP.";

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

async function loadLegacyBreadthDashboard(
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
          AND generation.status IN ('published', 'superseded')
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
    const memberCount = numeric(metrics.totalUniverseMembers, numeric(membership?.memberCount));
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
    } else if (coveragePct < requiredCoveragePct) {
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

type Dashboard = Awaited<ReturnType<typeof loadLegacyBreadthDashboard>>;
type PublishedSnapshot = NonNullable<Dashboard["universes"][number]["displayedSnapshot"]>;
type PublicationRow = EodStoredPayload & {
  id: string;
  scope: string;
  sessionDate: string;
  revision: number;
  createdAt: string;
  publicationId: string | null;
  publishedAt: string | null;
};

async function parsePublishedSnapshot(row: PublicationRow): Promise<PublishedSnapshot | null> {
  let decoded: unknown;
  try {
    const summary: unknown = JSON.parse(row.payload);
    const candidate = summary && typeof summary === "object" && !Array.isArray(summary) ? summary as Record<string, unknown> : null;
    const completeSummary = candidate?.methodologyVersion === EOD_METRICS_VERSION
      && ["advancers", "decliners", "unchanged", "pctAbove20MA", "pctAbove50MA", "pctAbove200MA",
        "new20DHighs", "new20DLows", "medianReturn1D", "medianReturn5D", "metrics", "membership"]
        .every((key) => Object.prototype.hasOwnProperty.call(candidate, key));
    // New Breadth summaries contain the complete scalar snapshot. Avoid one
    // gzip stream per historical row; decode only older incomplete summaries.
    decoded = completeSummary ? candidate : await decodeEodPayload(row);
  } catch { return null; }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
  const payload = decoded as Record<string, unknown>;
  if (payload.asOfDate !== row.sessionDate || payload.universeId !== row.scope.slice("breadth:".length)
    || !payload.metrics || typeof payload.metrics !== "object" || Array.isArray(payload.metrics)
    || (payload.methodologyVersion !== undefined && payload.methodologyVersion !== EOD_METRICS_VERSION)) return null;
  // Accepted publications must have a complete daily group; never manufacture
  // zero values when a corrupt/incompatible publication is encountered.
  if (![payload.advancers, payload.decliners, payload.unchanged].every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  return { ...payload, generatedAt: typeof payload.generatedAt === "string" ? payload.generatedAt : row.createdAt } as PublishedSnapshot;
}

/** New publications are immutable and independently promoted per universe.
 * Legacy data remains visible during rollout, explicitly identified as unverified. */
export async function loadBreadthDashboard(env: Env, historyLimitInput = 120, now = new Date()) {
  if (env.EOD_READ_ENABLED !== "true") return { ...await loadLegacyBreadthDashboard(env, historyLimitInput, now),
    exchangeSessionDates: undefined as string[] | undefined };
  const expectedAsOfSession = await expectedEodSession(env,now);
  if (!expectedAsOfSession) throw new Error("Exchange calendar unavailable; Breadth freshness cannot be verified.");
  const historyLimit = Math.max(1, Math.min(450, Math.trunc(historyLimitInput) || 120));
  const calendar = await getMarketDataDb(env).prepare(`SELECT session_date AS date FROM market_calendar_sessions
    WHERE session_date<=? ORDER BY session_date DESC LIMIT 1600`).bind(expectedAsOfSession).all<{date:string}>();
  const calendarDates = calendar.results.map((row) => row.date).reverse();
  const exchangeSessionDates = calendarDates.slice(-historyLimit);
  const scopes = JSON.stringify(CORE_BREADTH_UNIVERSE_IDS.map((id) => `breadth:${id}`));
  const rows = await getMarketDataDb(env).prepare(
    `WITH requested_ids AS (
       SELECT e.id FROM json_each(?) scopes CROSS JOIN json_each(?) dates
       JOIN eod_publications e ON e.id=(
         SELECT latest.id FROM eod_publications latest
         WHERE latest.scope=scopes.value AND latest.status='accepted' AND latest.session_date=dates.value
         ORDER BY latest.revision DESC,latest.created_at DESC,latest.id DESC LIMIT 1)
       UNION
       SELECT p.publication_id FROM eod_publication_pointers p
       JOIN eod_publications current ON current.id=p.publication_id AND current.scope=p.scope
         AND current.session_date=p.session_date AND current.status='accepted'
       WHERE p.scope IN (SELECT value FROM json_each(?)) AND p.session_date<=?
     )
     SELECT h.id, h.scope, h.session_date AS sessionDate, h.revision,
            h.payload_json AS payload, h.payload_codec AS payloadCodec, h.payload_base64 AS payloadBase64,
            h.created_at AS createdAt,
            p.publication_id AS publicationId, p.published_at AS publishedAt
       FROM requested_ids requested JOIN eod_publications h ON h.id=requested.id
       LEFT JOIN eod_publication_pointers p ON p.scope = h.scope
      ORDER BY h.scope, h.session_date DESC`,
  ).bind(scopes,JSON.stringify(exchangeSessionDates),scopes,expectedAsOfSession).all<PublicationRow>();
  const snapshots = new Map<string, PublishedSnapshot | null>();
  // History can contain up to 2,250 publications. Bound simultaneous gzip
  // streams so a long chart request cannot multiply decompression buffers.
  const publicationRows = rows.results ?? [];
  for (let offset = 0; offset < publicationRows.length; offset += 8) {
    const decoded = await Promise.all(publicationRows.slice(offset, offset + 8).map(async (row) =>
      [row.id, await parsePublishedSnapshot(row)] as const));
    for (const [id, snapshot] of decoded) snapshots.set(id, snapshot);
  }
  const byScope = new Map<string, PublicationRow[]>();
  for (const row of rows.results ?? []) {
    const current = byScope.get(row.scope) ?? [];
    current.push(row);
    byScope.set(row.scope, current);
  }
  const needsLegacy = CORE_BREADTH_UNIVERSE_IDS.some((id) => !byScope.get(`breadth:${id}`)?.some((row) => row.id === row.publicationId && snapshots.get(row.id)));
  const legacy = needsLegacy ? await loadLegacyBreadthDashboard(env, historyLimitInput, now) : null;
  type Universe = Omit<Dashboard["universes"][number],"membership"> & { publicationId?: string; revision?: number; legacyUnverified?: boolean;
    membership:Dashboard["universes"][number]["membership"] & {
      verifiedAt?:string|null;sourceAgeSessions?:number|null;degraded?:boolean;degradationReason?:string|null;
    } };
  const universes = CORE_BREADTH_UNIVERSE_IDS.map((universeId): Universe => {
    const history = byScope.get(`breadth:${universeId}`) ?? [];
    const current = history.find((row) => row.id === row.publicationId);
    const displayed = current ? snapshots.get(current.id) : null;
    if (!displayed || !current) {
      const fallback = legacy?.universes.find((row) => row.universeId === universeId);
      if (!fallback) throw new Error(`No compatible Breadth publication or legacy state for ${universeId}.`);
      return { ...fallback, legacyUnverified: true,
        freshness: fallback.displayedSnapshot ? "stale" : "missing", isFallback: true,
        error: { code: "legacy-breadth-unverified", message: "Displaying unverified legacy data until this universe receives its first EOD publication." } };
    }
    const raw = displayed as unknown as Record<string, unknown>;
    const membership = raw.membership && typeof raw.membership === "object" ? raw.membership as Record<string, unknown> : {};
    const metrics = displayed.metrics as Record<string, unknown>;
    const memberCount = numeric(metrics.totalUniverseMembers);
    const eligibleCount = numeric(metrics.memberCount);
    const coveragePct = numeric(metrics.dataCoveragePct);
    const requiredCoveragePct = minBreadthCoveragePct(universeId);
    const sourceMix = displayed.sourceMix && typeof displayed.sourceMix === "object" ? displayed.sourceMix as Record<string, unknown> : {};
    const stale = displayed.asOfDate !== expectedAsOfSession;
    const lowCoverage = coveragePct < requiredCoveragePct;
    const rawVerifiedAt = typeof membership.verifiedAt === "string" ? membership.verifiedAt : null;
    // D1 CURRENT_TIMESTAMP is UTC without a suffix. A post-close verification
    // can fall on the next UTC date while still belonging to this publication.
    const verifiedTime = rawVerifiedAt ? Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(rawVerifiedAt)
      ? `${rawVerifiedAt.replace(" ", "T")}Z` : rawVerifiedAt) : NaN;
    const validVerification = Number.isFinite(verifiedTime) && verifiedTime <= now.getTime()
      && verifiedTime <= Date.parse(current.createdAt);
    const verifiedAt = rawVerifiedAt && Number.isFinite(verifiedTime) ? rawVerifiedAt : null;
    const sourceAsOfDate = typeof membership.sourceAsOfDate === "string" ? membership.sourceAsOfDate : null;
    const localVerificationDate = validVerification ? zonedParts(new Date(verifiedTime), "America/New_York").localDate : null;
    const verifiedDate = localVerificationDate ? (localVerificationDate > displayed.asOfDate ? displayed.asOfDate : localVerificationDate)
      : rawVerifiedAt ? null : sourceAsOfDate;
    const sourceAgeSessions = verifiedDate === displayed.asOfDate ? 0
      : verifiedDate && verifiedDate <= displayed.asOfDate && calendarDates[0] && verifiedDate >= calendarDates[0]
        ? calendarDates.filter((date) => date > verifiedDate && date <= displayed.asOfDate).length : null;
    const degraded = membership.degraded === true || sourceAgeSessions === null || sourceAgeSessions > 0;
    const degradationReason = !degraded ? null : typeof membership.degradationReason === "string" ? membership.degradationReason
      : sourceAgeSessions === null ? "Membership verification age is unavailable for this publication."
        : `This publication used membership verified ${sourceAgeSessions} exchange session${sourceAgeSessions === 1 ? "" : "s"} earlier.`;
    return {
      universeId, universeName: typeof raw.universeName === "string" ? raw.universeName : UNIVERSE_NAMES[universeId]!,
      publicationId: current.id, revision: current.revision,
      displayedSnapshot: displayed, displayedAsOfSession: displayed.asOfDate,
      isFallback: stale, freshness: lowCoverage ? "low_coverage" : stale ? "stale" : "fresh",
      staleTradingSessions: calendarDates[0] && displayed.asOfDate >= calendarDates[0]
        ? calendarDates.filter((date) => date > displayed.asOfDate).length
        : countUsMarketTradingSessionsAfter(displayed.asOfDate, expectedAsOfSession),
      memberCount, exactSessionCount: eligibleCount, eligibleCount,
      unsupportedCount: numeric(membership.unresolvedCount), repairSourceCount: numeric(sourceMix.yahoo),
      coveragePct, requiredCoveragePct,
      membership: {
        versionId: typeof membership.versionId === "string" ? membership.versionId : null,
        source: typeof membership.source === "string" ? membership.source : null,
        sourceType: typeof membership.sourceType === "string" ? membership.sourceType : null,
        sourceUrl: typeof membership.sourceUrl === "string" ? membership.sourceUrl : null,
        sourceAsOfDate, verifiedAt, sourceAgeSessions, degraded, degradationReason,
        status: "published-version",
      },
      error: lowCoverage ? { code: "breadth-coverage-below-threshold", message: `Published coverage is ${coveragePct.toFixed(1)}%; required ${requiredCoveragePct}%.` }
        : stale ? { code: "breadth-generation-stale", message: `Displaying ${displayed.asOfDate}; no accepted publication exists for ${expectedAsOfSession}.` } : null,
      history: history.slice(0, historyLimit).map((row) => snapshots.get(row.id)).filter((row): row is PublishedSnapshot => Boolean(row)).reverse(),
    };
  });
  const problems = universes.filter((row) => row.freshness !== "fresh");
  const publishedAt = (rows.results ?? []).map((row) => row.publishedAt).filter((value): value is string => Boolean(value)).sort().at(-1) ?? legacy?.generatedAt ?? null;
  return {
    generationId: "per-universe", generatedAt: publishedAt, expectedAsOfSession, exchangeSessionDates, providerLabel: PROVIDER_LABEL,
    overallHealth: problems.length === 0 ? "fresh" : problems.length === universes.length ? "stale" : "partial",
    warning: problems.length ? `${problems.length} of ${universes.length} Breadth universes are unavailable, stale, or unverified for ${expectedAsOfSession}.` : null,
    universes,
  };
}
