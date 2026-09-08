import { loadSnapshot } from "./eod";
import { loadBreadthDashboard } from "./breadth-dashboard-service";
import { eodStatus } from "./eod-coordinator";
import type { Env } from "./types";

/** Read-only compatibility response for /api/status during EOD rollout. Every
 * date, coverage figure and provider label comes from the displayed publication. */
export async function loadEodApiStatus(env: Env, page = "overview", now = new Date()) {
  const [overview, breadth, readiness] = await Promise.all([
    loadSnapshot(env, "default", undefined, { allowComputeOnMissing: false }),
    loadBreadthDashboard(env, 1, now),
    eodStatus(env, now),
  ]);
  const dates = breadth.universes.map((row) => row.displayedAsOfSession).filter((date): date is string => Boolean(date)).sort();
  const breadthAsOf = dates[0] ?? null;
  const isBreadth = page === "breadth";
  const expected = readiness.expectedSession ?? null;
  const anyBreadth = breadth.universes.some((row) => row.displayedSnapshot !== null);
  const breadthServing = !anyBreadth ? "unavailable" : breadth.overallHealth === "fresh" ? "ready"
    : breadth.overallHealth === "partial" ? "degraded" : "stale_fallback";
  return {
    configId: overview.config?.id ?? "default",
    timezone: overview.config?.timezone ?? env.APP_TIMEZONE ?? "Australia/Melbourne",
    autoRefreshLabel: "US session close +20m; retries through close +2h",
    autoRefreshLocalTime: "close+20m",
    lastUpdated: isBreadth ? breadth.generatedAt : overview.generatedAt,
    asOfDate: isBreadth ? breadthAsOf : overview.asOfDate,
    providerLabel: (isBreadth ? breadth.providerLabel : overview.providerLabel) ?? "Verified EOD publications",
    servingState: isBreadth ? breadthServing : overview.servingState,
    staleTradingSessions: isBreadth ? Math.max(0, ...breadth.universes.map((row) => row.staleTradingSessions)) : overview.staleTradingSessions,
    overviewRecovery: null,
    dataProvider: "eod-publications",
    expectedAsOfDate: expected,
    freshnessStatus: !expected ? "stale" : overview.freshnessStatus,
    freshnessCoveragePct: overview.freshnessCoveragePct ?? null,
    freshnessCurrentCount: overview.freshnessCurrentCount ?? null,
    freshnessEligibleCount: overview.freshnessEligibleCount ?? null,
    freshnessCriticalMissingTickers: overview.freshnessCriticalMissingTickers ?? [],
    freshnessMinBarDate: overview.freshnessMinBarDate ?? null,
    freshnessMaxBarDate: overview.freshnessMaxBarDate ?? null,
    freshnessWarning: !expected ? "The completed exchange session could not be verified from the calendar cache." : overview.freshnessWarning ?? null,
    quoteOverlayRequestedCount: overview.quoteOverlayRequestedCount ?? null,
    quoteOverlayReturnedCount: overview.quoteOverlayReturnedCount ?? null,
    quoteOverlayError: overview.quoteOverlayError ?? null,
    quoteOverlayMissingSample: overview.quoteOverlayMissingSample ?? [],
    breadthExpectedAsOfDate: expected,
    breadthStatus: breadth.overallHealth,
    breadthLatestAsOfDate: dates.at(-1) ?? null,
    breadthLastUpdated: breadth.generatedAt,
    breadthWarning: breadth.warning,
    breadthDiagnostics: breadth.universes.map((row) => ({
      universeId: row.universeId, expectedAsOfDate: expected, latestAsOfDate: row.displayedAsOfSession,
      latestGeneratedAt: row.displayedSnapshot?.generatedAt ?? null, memberCount: row.memberCount,
      currentDateTickers: row.exactSessionCount, coveragePct: row.coveragePct,
      minCoveragePct: row.requiredCoveragePct, status: row.freshness,
      reason: row.error?.message ?? `Accepted publication for ${row.displayedAsOfSession}.`,
    })),
    eodReadiness: readiness,
  };
}
