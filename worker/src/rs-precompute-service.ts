import { latestUsMarketSessionAsOfDate } from "./market-calendar";
import { loadStoredMarketSession } from "./market-calendar-cache";
import { getMarketDataDb } from "./market-data-db";
import { getOpsDb } from "./ops-db";
import {
  createScheduledRelativeStrengthRun,
  hasMatchingRelativeStrengthPublication,
  listActiveRelativeStrengthPrecomputePresets,
  loadScannerCacheCapacity,
  loadLatestCompletedManualRelativeStrengthRunForConfig,
  relativeStrengthPrecomputeBenchmarkDataTicker,
  relativeStrengthPrecomputeConfigKey,
  relativeStrengthPrecomputeRequiredBarCount,
  publishRelativeStrengthPresetFromCompletedRun,
} from "./scans-page-service";
import type { Env, WorkerScheduleSettings } from "./types";
import { isPostCloseBarsWindowOpen, postCloseJobIdentity } from "./worker-schedule-service";

export type RelativeStrengthPrecomputePlanStatus =
  | "disabled" | "before-post-close" | "waiting-for-bars" | "waiting-for-benchmark"
  | "already-ready" | "active" | "queued" | "failed";

export type RelativeStrengthPrecomputePlanResult = {
  status: RelativeStrengthPrecomputePlanStatus;
  expectedTradingDate: string;
  runId?: string;
  configKey?: string;
  reason?: string;
};

type PostCloseReadyRow = {
  id: string;
  status: string;
  totalTickers: number;
  processedTickers: number;
  missingCurrentDateTickers: number;
  currentDateCoveragePct: number;
};

export function postCloseBarsAreReady(job: PostCloseReadyRow | null): boolean {
  return Boolean(job && job.status === "completed" && Number(job.totalTickers) > 0
    && Number(job.processedTickers) === Number(job.totalTickers)
    && Number(job.missingCurrentDateTickers) === 0
    && Number(job.currentDateCoveragePct) >= 100);
}

export function groupRelativeStrengthPrecomputeConfigs<T>(
  presets: T[],
  configKey: (preset: T) => string,
): Map<string, T> {
  const grouped = new Map<string, T>();
  for (const preset of presets) if (!grouped.has(configKey(preset))) grouped.set(configKey(preset), preset);
  return grouped;
}

export async function planScheduledRelativeStrengthPrecompute(
  env: Env,
  now: Date,
  settings: WorkerScheduleSettings,
): Promise<RelativeStrengthPrecomputePlanResult> {
  const expectedTradingDate = latestUsMarketSessionAsOfDate(now);
  if (!settings.postCloseBarsEnabled || !settings.rsBackgroundEnabled || !env.SCANNER_CACHE_DB || !env.MARKET_DATA_DB) {
    return { status: "disabled", expectedTradingDate };
  }
  const capacity = await loadScannerCacheCapacity(env);
  if (capacity.status === "halt") {
    return { status: "failed", expectedTradingDate, reason: "Scanner cache capacity halt threshold reached; previous publications remain active." };
  }
  const session = await loadStoredMarketSession(env, expectedTradingDate).catch(() => null);
  if (!isPostCloseBarsWindowOpen(now, expectedTradingDate, settings.postCloseBarsOffsetMinutes, session?.closeAt)) {
    return { status: "before-post-close", expectedTradingDate };
  }
  const source = postCloseJobIdentity(env);
  const marketDataDb = getMarketDataDb(env);
  const barsJob = await getOpsDb(env).prepare(
    `SELECT id, status, total_tickers as totalTickers, processed_tickers as processedTickers,
       missing_current_date_tickers as missingCurrentDateTickers, current_date_coverage_pct as currentDateCoveragePct
     FROM post_close_daily_bar_refresh_jobs
     WHERE trading_date = ? AND source_provider = ? AND source_feed = ? AND adjustment = ?
     ORDER BY datetime(completed_at) DESC, datetime(updated_at) DESC LIMIT 1`,
  ).bind(expectedTradingDate, source.provider, source.feed, source.adjustment).first<PostCloseReadyRow>();
  if (!postCloseBarsAreReady(barsJob)) {
    return { status: "waiting-for-bars", expectedTradingDate };
  }

  const presets = await listActiveRelativeStrengthPrecomputePresets(env);
  const configs = groupRelativeStrengthPrecomputeConfigs(
    presets,
    (preset) => relativeStrengthPrecomputeConfigKey(preset, expectedTradingDate),
  );
  if (configs.size === 0) return { status: "already-ready", expectedTradingDate };

  for (const preset of configs.values()) {
    const benchmarkTicker = relativeStrengthPrecomputeBenchmarkDataTicker(preset, expectedTradingDate);
    const requiredBarCount = relativeStrengthPrecomputeRequiredBarCount(preset, expectedTradingDate);
    const benchmark = await marketDataDb.prepare(
      `SELECT MAX(date) as latestDate, COUNT(*) as barCount FROM (
         SELECT date FROM alpaca_daily_bars WHERE feed = ? AND ticker = ? ORDER BY date DESC LIMIT ?
       )`,
    ).bind(source.feed, benchmarkTicker, requiredBarCount).first<{ latestDate: string | null; barCount: number }>();
    if (benchmark?.latestDate !== expectedTradingDate || Number(benchmark?.barCount ?? 0) < requiredBarCount) {
      return { status: "waiting-for-benchmark", expectedTradingDate, reason: `${benchmarkTicker} history is incomplete.` };
    }
  }

  for (const [configKey, representative] of configs) {
    const completed = await loadLatestCompletedManualRelativeStrengthRunForConfig(env, configKey, expectedTradingDate, "scheduled");
    if (!completed) continue;
    const matchingPresets = presets.filter((preset) => relativeStrengthPrecomputeConfigKey(preset, expectedTradingDate) === configKey);
    for (const preset of matchingPresets) {
      if (!(await hasMatchingRelativeStrengthPublication(env, preset.id, configKey, expectedTradingDate))) {
        await publishRelativeStrengthPresetFromCompletedRun(env as Env & { SCANNER_CACHE_DB: D1Database }, preset, completed);
      }
    }
    if (representative) configs.delete(configKey);
  }
  if (configs.size === 0) return { status: "already-ready", expectedTradingDate };

  const active = await env.SCANNER_CACHE_DB.prepare(
    `SELECT id, config_key as configKey, expected_trading_date as expectedTradingDate
     FROM rs_scan_runs WHERE status IN ('queued', 'running')
       AND (lease_expires_at > CURRENT_TIMESTAMP OR datetime(COALESCE(heartbeat_at, updated_at)) >= datetime('now', '-15 minutes'))
     ORDER BY datetime(created_at) ASC LIMIT 1`,
  ).first<{ id: string; configKey: string; expectedTradingDate: string }>();
  if (active) return { status: "active", expectedTradingDate, runId: active.id, configKey: active.configKey };

  const [configKey, preset] = configs.entries().next().value as [string, (typeof presets)[number]];
  try {
    const run = await createScheduledRelativeStrengthRun(env as Env & { SCANNER_CACHE_DB: D1Database }, preset, expectedTradingDate, barsJob!.id);
    return { status: run.status === "completed" ? "already-ready" : "queued", expectedTradingDate, runId: run.id, configKey };
  } catch (error) {
    return { status: "failed", expectedTradingDate, configKey, reason: error instanceof Error ? error.message : String(error) };
  }
}
