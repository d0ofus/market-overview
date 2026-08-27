import { envFlagEnabled } from "./auth";
import { computeAndStoreSnapshot, OverviewFreshnessError } from "./eod";
import { countUsMarketTradingSessionsAfter, latestUsMarketSessionAsOfDate } from "./market-calendar";
import { getOpsDb } from "./ops-db";
import { getMarketDataDb } from "./market-data-db";
import {
  loadOverviewCurrentRefreshJob,
  overviewCurrentRefreshStateAllowsPublication,
  type OverviewCurrentRefreshJobState,
} from "./overview-current-data";
import { finishScheduledJobRun, startScheduledJobRun } from "./scheduled-job-audit";
import type { Env, OverviewRecovery, OverviewServingState } from "./types";

export type OverviewPublicationQuality = "ready" | "degraded" | "bootstrap" | "rejected";

export type PublishedOverviewGeneration = {
  generationId: string;
  asOfDate: string;
  generatedAt: string;
  providerLabel: string;
  expectedAsOfDate: string | null;
  status: "ready" | "rejected";
  publicationQuality: OverviewPublicationQuality | null;
  freshnessStatus: "fresh" | "partial" | "stale" | string | null;
  freshnessCoveragePct: number | null;
  freshnessCurrentCount: number | null;
  freshnessEligibleCount: number | null;
  freshnessCriticalMissingJson: string | null;
  freshnessMinBarDate: string | null;
  freshnessMaxBarDate: string | null;
  freshnessWarning: string | null;
  quoteOverlayRequestedCount: number | null;
  quoteOverlayReturnedCount: number | null;
  quoteOverlayError: string | null;
  quoteOverlayMissingSampleJson: string | null;
  sourceCycleId: string | null;
  publicationCoveragePct: number | null;
  publicationCriticalMissingJson: string | null;
};

export type OverviewPublicationReconcileResult = OverviewRecovery & {
  publishedAt: string | null;
  servingState: OverviewServingState;
  staleTradingSessions: number;
};

type GenerationRow = PublishedOverviewGeneration & { coveragePct?: number | null };

type ReadinessRow = {
  generationId: string | null;
  status: string;
  coveragePct: number | null;
  warning: string | null;
  updatedAt: string | null;
};

export function isOverviewPublicationRecoveryEnabled(env: Env): boolean {
  return envFlagEnabled(env.OVERVIEW_PUBLICATION_RECOVERY_ENABLED);
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error ?? "Overview publication failed.")).slice(0, 500);
}

function isSchemaUnavailable(error: unknown): boolean {
  return /no such table|no such column/i.test(errorMessage(error));
}

function parseDateMs(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  return Date.parse(value.includes("T") || value.endsWith("Z") ? value : `${value.replace(" ", "T")}Z`);
}

function servingStateFor(generation: PublishedOverviewGeneration | null, expectedAsOfDate: string): OverviewServingState {
  if (!generation) return "unavailable";
  if (generation.asOfDate < expectedAsOfDate) return "stale_fallback";
  return generation.publicationQuality === "degraded" ? "degraded" : "ready";
}

const GENERATION_SELECT = `SELECT g.id as generationId, g.as_of_date as asOfDate,
  g.generated_at as generatedAt, g.provider_label as providerLabel,
  g.expected_as_of_date as expectedAsOfDate, g.status,
  g.publication_quality as publicationQuality, g.freshness_status as freshnessStatus,
  g.current_count as freshnessCurrentCount, g.eligible_count as freshnessEligibleCount,
  g.coverage_pct as freshnessCoveragePct, g.critical_missing_json as freshnessCriticalMissingJson,
  g.min_bar_date as freshnessMinBarDate, g.max_bar_date as freshnessMaxBarDate,
  g.warning as freshnessWarning, g.quote_requested_count as quoteOverlayRequestedCount,
  g.quote_returned_count as quoteOverlayReturnedCount, g.quote_error as quoteOverlayError,
  g.quote_missing_sample_json as quoteOverlayMissingSampleJson,
  g.source_cycle_id as sourceCycleId,
  g.essential_current_coverage_pct as publicationCoveragePct,
  g.publication_critical_missing_json as publicationCriticalMissingJson
  FROM overview_generations g`;

const LEGACY_GENERATION_SELECT = `SELECT g.id as generationId, g.as_of_date as asOfDate,
  g.generated_at as generatedAt, g.provider_label as providerLabel,
  g.expected_as_of_date as expectedAsOfDate, g.status,
  NULL as publicationQuality, g.freshness_status as freshnessStatus,
  g.current_count as freshnessCurrentCount, g.eligible_count as freshnessEligibleCount,
  g.coverage_pct as freshnessCoveragePct, g.critical_missing_json as freshnessCriticalMissingJson,
  g.min_bar_date as freshnessMinBarDate, g.max_bar_date as freshnessMaxBarDate,
  g.warning as freshnessWarning, g.quote_requested_count as quoteOverlayRequestedCount,
  g.quote_returned_count as quoteOverlayReturnedCount, g.quote_error as quoteOverlayError,
  g.quote_missing_sample_json as quoteOverlayMissingSampleJson,
  NULL as sourceCycleId, NULL as publicationCoveragePct,
  NULL as publicationCriticalMissingJson
  FROM overview_generations g`;

export async function loadPublishedOverviewGeneration(
  env: Env,
  configId = "default",
): Promise<{ schemaAvailable: boolean; generation: PublishedOverviewGeneration | null }> {
  try {
    const generation = await getMarketDataDb(env).prepare(
      `${GENERATION_SELECT}
       JOIN overview_snapshot_pointer p ON p.generation_id = g.id
       WHERE p.config_id = ? AND g.status = 'ready'
       LIMIT 1`,
    ).bind(configId).first<GenerationRow>();
    return { schemaAvailable: true, generation: generation ?? null };
  } catch (error) {
    if (!isSchemaUnavailable(error)) throw error;
    try {
      const generation = await getMarketDataDb(env).prepare(
        `${LEGACY_GENERATION_SELECT}
         JOIN overview_snapshot_pointer p ON p.generation_id = g.id
         WHERE p.config_id = ? AND g.status = 'ready'
         LIMIT 1`,
      ).bind(configId).first<GenerationRow>();
      return { schemaAvailable: true, generation: generation ?? null };
    } catch (fallbackError) {
      if (!isSchemaUnavailable(fallbackError)) throw fallbackError;
      return { schemaAvailable: false, generation: null };
    }
  }
}

async function loadSourceGeneration(
  env: Env,
  configId: string,
  asOfDate: string,
  sourceCycleId: string,
): Promise<PublishedOverviewGeneration | null> {
  try {
    return await getMarketDataDb(env).prepare(
      `${GENERATION_SELECT}
       WHERE g.config_id = ? AND g.as_of_date = ? AND g.source_cycle_id = ?
       LIMIT 1`,
    ).bind(configId, asOfDate, sourceCycleId).first<GenerationRow>();
  } catch (error) {
    if (isSchemaUnavailable(error)) return null;
    throw error;
  }
}

async function loadOverviewReadiness(env: Env, configId: string): Promise<ReadinessRow | null> {
  try {
    return await getMarketDataDb(env).prepare(
      `SELECT generation_id as generationId, status, coverage_pct as coveragePct,
              warning, updated_at as updatedAt
       FROM data_readiness WHERE domain = 'overview' AND scope = ? LIMIT 1`,
    ).bind(configId).first<ReadinessRow>();
  } catch (error) {
    if (isSchemaUnavailable(error)) return null;
    throw error;
  }
}

async function recordOverviewReadiness(env: Env, input: {
  configId: string;
  expectedAsOfDate: string;
  sourceAsOfDate: string | null;
  generationId: string | null;
  status: string;
  coveragePct: number | null;
  warning: string | null;
}): Promise<void> {
  await getMarketDataDb(env).prepare(
    `INSERT INTO data_readiness
       (domain, scope, expected_as_of_date, source_as_of_date, generation_id,
        status, coverage_pct, warning, updated_at)
     VALUES ('overview', ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(domain, scope) DO UPDATE SET
       expected_as_of_date = excluded.expected_as_of_date,
       source_as_of_date = excluded.source_as_of_date,
       generation_id = excluded.generation_id,
       status = excluded.status,
       coverage_pct = excluded.coverage_pct,
       warning = excluded.warning,
       updated_at = CURRENT_TIMESTAMP`,
  ).bind(
    input.configId,
    input.expectedAsOfDate,
    input.sourceAsOfDate,
    input.generationId,
    input.status,
    input.coveragePct,
    input.warning,
  ).run();
}

async function loadExpectedCurrentJob(
  env: Env,
  configId: string,
  expectedAsOfDate: string,
): Promise<OverviewCurrentRefreshJobState | null> {
  try {
    return await loadOverviewCurrentRefreshJob(env, configId, expectedAsOfDate);
  } catch (error) {
    if (isSchemaUnavailable(error)) return null;
    throw error;
  }
}

function recoveryFrom(
  expectedAsOfDate: string,
  job: OverviewCurrentRefreshJobState | null,
  generation: PublishedOverviewGeneration | null,
  readiness: ReadinessRow | null,
  published: PublishedOverviewGeneration | null,
): OverviewPublicationReconcileResult {
  const incomplete = Boolean(job?.cycleId) && !overviewCurrentRefreshStateAllowsPublication(job);
  let status: OverviewRecovery["status"] = "idle";
  if (incomplete) status = "refreshing_current";
  else if (generation?.status === "rejected") status = "blocked";
  else if (generation?.status === "ready") status = "published";
  else if (job?.cycleId && readiness?.status === "retrying") status = "retrying";
  else if (job?.cycleId) status = "ready_to_publish";
  const publicationCoveragePct = generation?.publicationCoveragePct
    ?? (job && job.requestedTickers > 0 ? (job.freshTickers / job.requestedTickers) * 100 : null);
  const readinessRetryAt = readiness?.status === "retrying" && Number.isFinite(parseDateMs(readiness.updatedAt))
    ? new Date(parseDateMs(readiness.updatedAt) + 5 * 60_000).toISOString()
    : null;
  return {
    expectedAsOfDate,
    status,
    sourceCycleId: job?.cycleId ?? null,
    processedTickers: job?.processedTickers ?? null,
    requestedTickers: job?.requestedTickers ?? null,
    freshTickers: job?.freshTickers ?? null,
    unavailableTickers: job?.unavailableTickers ?? null,
    historyCoveragePct: generation?.freshnessCoveragePct ?? null,
    publicationCoveragePct,
    generationId: generation?.generationId ?? null,
    lastAttemptAt: generation?.generatedAt ?? (readiness?.status === "retrying" ? readiness.updatedAt : job?.updatedAt ?? null),
    nextAttemptAt: job?.nextAttemptAt ?? readinessRetryAt,
    lastErrorCode: job?.lastErrorCode ?? (readiness?.status === "retrying" ? "publication_error" : null),
    lastError: job?.lastError ?? (readiness?.status === "retrying" || readiness?.status === "blocked" ? readiness.warning : null),
    publishedAt: generation?.status === "ready" ? generation.generatedAt : null,
    servingState: servingStateFor(published, expectedAsOfDate),
    staleTradingSessions: countUsMarketTradingSessionsAfter(published?.asOfDate ?? null, expectedAsOfDate),
  };
}

export async function loadOverviewRecovery(
  env: Env,
  now = new Date(),
  configId = "default",
): Promise<OverviewPublicationReconcileResult> {
  const expectedAsOfDate = latestUsMarketSessionAsOfDate(now);
  const [job, publishedResult, readiness] = await Promise.all([
    loadExpectedCurrentJob(env, configId, expectedAsOfDate),
    loadPublishedOverviewGeneration(env, configId),
    loadOverviewReadiness(env, configId),
  ]);
  const generation = job?.cycleId
    ? await loadSourceGeneration(env, configId, expectedAsOfDate, job.cycleId)
    : null;
  return recoveryFrom(expectedAsOfDate, job, generation, readiness, publishedResult.generation);
}

async function promoteOverviewPointerIfNewer(env: Env, configId: string, generationId: string): Promise<void> {
  await getMarketDataDb(env).prepare(
    `INSERT INTO overview_snapshot_pointer (config_id, generation_id, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(config_id) DO UPDATE SET
       generation_id = excluded.generation_id,
       updated_at = CURRENT_TIMESTAMP
     WHERE (SELECT as_of_date FROM overview_generations WHERE id = excluded.generation_id) >
           COALESCE((SELECT as_of_date FROM overview_generations WHERE id = overview_snapshot_pointer.generation_id), '')
        OR ((SELECT as_of_date FROM overview_generations WHERE id = excluded.generation_id) =
            (SELECT as_of_date FROM overview_generations WHERE id = overview_snapshot_pointer.generation_id)
            AND datetime((SELECT generated_at FROM overview_generations WHERE id = excluded.generation_id)) >
                datetime((SELECT generated_at FROM overview_generations WHERE id = overview_snapshot_pointer.generation_id)))`,
  ).bind(configId, generationId).run();
}

async function verifyPointer(env: Env, configId: string): Promise<PublishedOverviewGeneration | null> {
  return (await loadPublishedOverviewGeneration(env, configId)).generation;
}

async function reconcileReadyGeneration(
  env: Env,
  expectedAsOfDate: string,
  configId: string,
  generation: PublishedOverviewGeneration,
): Promise<PublishedOverviewGeneration | null> {
  await promoteOverviewPointerIfNewer(env, configId, generation.generationId);
  const pointed = await verifyPointer(env, configId);
  if (!pointed) throw new Error("Overview pointer verification failed after publication.");
  await recordOverviewReadiness(env, {
    configId,
    expectedAsOfDate,
    sourceAsOfDate: pointed.asOfDate,
    generationId: pointed.generationId,
    status: pointed.publicationQuality === "degraded" ? "degraded" : pointed.publicationQuality === "bootstrap" ? "bootstrap" : "ready",
    coveragePct: pointed.publicationCoveragePct ?? pointed.freshnessCoveragePct,
    warning: pointed.freshnessWarning,
  });
  return pointed;
}

export async function reconcileOverviewPublication(
  env: Env,
  now = new Date(),
  configId = "default",
): Promise<OverviewPublicationReconcileResult> {
  const expectedAsOfDate = latestUsMarketSessionAsOfDate(now);
  const job = await loadExpectedCurrentJob(env, configId, expectedAsOfDate);
  const publishedBefore = (await loadPublishedOverviewGeneration(env, configId)).generation;
  if (!job?.cycleId || !overviewCurrentRefreshStateAllowsPublication(job)) {
    return recoveryFrom(expectedAsOfDate, job, null, await loadOverviewReadiness(env, configId), publishedBefore);
  }

  const existing = await loadSourceGeneration(env, configId, expectedAsOfDate, job.cycleId);
  if (existing?.status === "rejected") {
    await recordOverviewReadiness(env, {
      configId,
      expectedAsOfDate,
      sourceAsOfDate: existing.asOfDate,
      generationId: existing.generationId,
      status: "blocked",
      coveragePct: existing.publicationCoveragePct,
      warning: existing.freshnessWarning,
    });
    return recoveryFrom(expectedAsOfDate, job, existing, await loadOverviewReadiness(env, configId), publishedBefore);
  }
  if (existing?.status === "ready") {
    const pointed = await reconcileReadyGeneration(env, expectedAsOfDate, configId, existing);
    return recoveryFrom(expectedAsOfDate, job, pointed, await loadOverviewReadiness(env, configId), pointed);
  }

  const snapshotId = crypto.randomUUID();
  try {
    await computeAndStoreSnapshot(env, expectedAsOfDate, configId, {
      includeBreadth: false,
      sourceCycleId: job.cycleId,
      snapshotId,
    });
    const created = await loadSourceGeneration(env, configId, expectedAsOfDate, job.cycleId);
    if (!created || created.status !== "ready") {
      throw new Error("Overview generation was not readable after publication.");
    }
    const pointed = await reconcileReadyGeneration(env, expectedAsOfDate, configId, created);
    return recoveryFrom(expectedAsOfDate, job, pointed, await loadOverviewReadiness(env, configId), pointed);
  } catch (error) {
    const winner = await loadSourceGeneration(env, configId, expectedAsOfDate, job.cycleId).catch(() => null);
    if (winner) {
      await getMarketDataDb(env).prepare("DELETE FROM snapshot_rows WHERE snapshot_id = ? AND snapshot_id <> ?")
        .bind(snapshotId, winner.generationId).run().catch(() => undefined);
      if (winner.status === "ready") {
        const pointed = await reconcileReadyGeneration(env, expectedAsOfDate, configId, winner);
        return recoveryFrom(expectedAsOfDate, job, pointed, await loadOverviewReadiness(env, configId), pointed);
      }
      return recoveryFrom(expectedAsOfDate, job, winner, await loadOverviewReadiness(env, configId), publishedBefore);
    }
    if (error instanceof OverviewFreshnessError) {
      const rejected = await loadSourceGeneration(env, configId, expectedAsOfDate, job.cycleId);
      return recoveryFrom(expectedAsOfDate, job, rejected, await loadOverviewReadiness(env, configId), publishedBefore);
    }
    await getMarketDataDb(env).prepare("DELETE FROM snapshot_rows WHERE snapshot_id = ?")
      .bind(snapshotId).run().catch(() => undefined);
    const message = errorMessage(error);
    await recordOverviewReadiness(env, {
      configId,
      expectedAsOfDate,
      sourceAsOfDate: expectedAsOfDate,
      generationId: null,
      status: "retrying",
      coveragePct: job.requestedTickers > 0 ? (job.freshTickers / job.requestedTickers) * 100 : null,
      warning: message,
    }).catch(() => undefined);
    console.error("overview publication reconciliation failed", {
      configId,
      expectedAsOfDate,
      sourceCycleId: job.cycleId,
      error: message,
    });
    return recoveryFrom(expectedAsOfDate, job, null, await loadOverviewReadiness(env, configId), publishedBefore);
  }
}

type FreshnessAuditMetadata = {
  event?: string;
  staleStateKey?: string;
  configId?: string;
};

async function loadLatestFreshnessAuditMetadata(env: Env, configId: string): Promise<FreshnessAuditMetadata | null> {
  try {
    const row = await getOpsDb(env).prepare(
      `SELECT metadata_json as metadataJson FROM scheduled_job_runs
       WHERE job_key = 'overview-freshness-alert'
         AND json_valid(metadata_json)
         AND json_extract(metadata_json, '$.configId') = ?
       ORDER BY datetime(started_at) DESC LIMIT 1`,
    ).bind(configId).first<{ metadataJson: string | null }>();
    if (!row?.metadataJson) return null;
    const parsed = JSON.parse(row.metadataJson) as unknown;
    return parsed && typeof parsed === "object" ? parsed as FreshnessAuditMetadata : null;
  } catch (error) {
    if (isSchemaUnavailable(error)) return null;
    throw error;
  }
}

export async function auditOverviewFreshnessState(
  env: Env,
  now: Date,
  recovery: OverviewPublicationReconcileResult,
  configId = "default",
): Promise<void> {
  const published = (await loadPublishedOverviewGeneration(env, configId)).generation;
  const staleStateKey = `${configId}:${published?.asOfDate ?? "none"}:${recovery.expectedAsOfDate}`;
  const latest = await loadLatestFreshnessAuditMetadata(env, configId);
  if (recovery.staleTradingSessions > 1) {
    if (latest?.event === "alert" && latest.staleStateKey === staleStateKey) return;
    const metadata = {
      event: "alert",
      staleStateKey,
      configId,
      pointerGenerationId: published?.generationId ?? null,
      publishedAsOfDate: published?.asOfDate ?? null,
      expectedAsOfDate: recovery.expectedAsOfDate,
      staleTradingSessions: recovery.staleTradingSessions,
      sourceCycleId: recovery.sourceCycleId,
      processedTickers: recovery.processedTickers,
      requestedTickers: recovery.requestedTickers,
      recoveryStatus: recovery.status,
      lastAttemptAt: recovery.lastAttemptAt,
      lastErrorCode: recovery.lastErrorCode,
      lastError: recovery.lastError,
      servingState: recovery.servingState,
    };
    const id = await startScheduledJobRun(env, {
      lane: "market-data",
      cron: null,
      jobKey: "overview-freshness-alert",
      scheduledTime: now.toISOString(),
      metadata,
    });
    await finishScheduledJobRun(env, id, "failed", "Overview is more than one completed trading session old.", metadata);
    console.error("overview-freshness-alert", metadata);
    return;
  }
  if (latest?.event === "alert" && (recovery.servingState === "ready" || recovery.servingState === "degraded")) {
    const metadata = {
      event: "recovered",
      staleStateKey,
      configId,
      pointerGenerationId: published?.generationId ?? null,
      publishedAsOfDate: published?.asOfDate ?? null,
      expectedAsOfDate: recovery.expectedAsOfDate,
      staleTradingSessions: recovery.staleTradingSessions,
      servingState: recovery.servingState,
    };
    const id = await startScheduledJobRun(env, {
      lane: "market-data",
      cron: null,
      jobKey: "overview-freshness-alert",
      scheduledTime: now.toISOString(),
      metadata,
    });
    await finishScheduledJobRun(env, id, "completed", null, metadata);
    console.info("overview freshness recovered", metadata);
  }
}
