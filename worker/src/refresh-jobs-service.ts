import type { Env } from "./types";
import { getOpsDb, marketPipelineMode } from "./ops-db";

const REFRESH_JOB_LEASE_MS = 2 * 60_000;
const COMMENTARY_REFRESH_JOB_LEASE_MS = 4 * 60_000;
const REFRESH_JOB_DEDUPE_MS = 5 * 60_000;
const REFRESH_JOB_MAX_ATTEMPTS = 3;

async function recordPipelineRun(
  env: Env,
  job: Pick<RefreshJob, "id" | "page" | "ticker">,
  input: {
    stage: string;
    status: string;
    sessionDate?: string | null;
    completedCount?: number | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    checkpoint?: unknown;
    nextAttemptAt?: string | null;
    completedAt?: string | null;
    now: Date;
  },
): Promise<void> {
  await getOpsDb(env).prepare(
    `INSERT INTO market_pipeline_runs
       (id, pipeline, session_date, mode, stage, status, completed_count, error_code,
        error_message, checkpoint_json, next_attempt_at, started_at, completed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       session_date = COALESCE(excluded.session_date, market_pipeline_runs.session_date),
       mode = excluded.mode, stage = excluded.stage, status = excluded.status,
       completed_count = COALESCE(excluded.completed_count, market_pipeline_runs.completed_count),
       error_code = excluded.error_code, error_message = excluded.error_message,
       checkpoint_json = COALESCE(excluded.checkpoint_json, market_pipeline_runs.checkpoint_json),
       next_attempt_at = excluded.next_attempt_at,
       completed_at = excluded.completed_at, updated_at = excluded.updated_at`,
  ).bind(
    job.id,
    `manual:${job.page}`,
    input.sessionDate ?? null,
    marketPipelineMode(env),
    input.stage,
    input.status,
    input.completedCount ?? null,
    input.errorCode ?? null,
    input.errorMessage?.slice(0, 700) ?? null,
    input.checkpoint == null ? null : JSON.stringify({ ticker: job.ticker, value: input.checkpoint }),
    input.nextAttemptAt ?? null,
    input.now.toISOString(),
    input.completedAt ?? null,
    input.now.toISOString(),
  ).run();
}

export type RefreshJobStatus = "queued" | "running" | "completed" | "failed";

export type RefreshJob = {
  id: string;
  page: string;
  ticker: string | null;
  status: RefreshJobStatus;
  attemptCount: number;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  nextAttemptAt: string | null;
  result: {
    page: string;
    refreshedTickers: number;
    notes?: string;
    generationId?: string;
    publishedAt?: string;
    currentCoveragePct?: number;
    historyExactCoveragePct?: number;
    historyUsableCoveragePct?: number;
    reportId?: string;
    sessionDate?: string;
    canonicalSession?: string;
    historyRefreshStatus?: string;
    historyErrorCode?: string | null;
    historyNextAttemptAt?: string | null;
    publicationStatus?: "published" | "recovering" | "blocked";
    publicationNextAttemptAt?: string | null;
    publicationErrorCode?: string | null;
    publicationError?: string | null;
  } | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

type RefreshJobRow = Omit<RefreshJob, "result"> & { resultJson: string | null };

export function refreshJobIdempotencyKey(page: string, ticker: string | null, now = new Date()): string {
  const bucket = Math.floor(now.getTime() / REFRESH_JOB_DEDUPE_MS);
  return `${page.trim().toLowerCase()}:${ticker?.trim().toUpperCase() ?? ""}:${bucket}`;
}

export function isRefreshJobClaimable(
  status: RefreshJobStatus,
  nextAttemptAt: string | null,
  leaseExpiresAt: string | null,
  now = new Date(),
): boolean {
  if (status === "queued") return !nextAttemptAt || Date.parse(nextAttemptAt) <= now.getTime();
  return status === "running" && Boolean(leaseExpiresAt) && Date.parse(leaseExpiresAt as string) <= now.getTime();
}

function mapRow(row: RefreshJobRow): RefreshJob {
  let result: RefreshJob["result"] = null;
  if (row.resultJson) {
    try {
      result = JSON.parse(row.resultJson) as RefreshJob["result"];
    } catch {
      result = null;
    }
  }
  return { ...row, result };
}

const REFRESH_JOB_SELECT = `SELECT id, page, ticker, status, attempt_count as attemptCount,
  lease_token as leaseToken, lease_expires_at as leaseExpiresAt,
  next_attempt_at as nextAttemptAt, result_json as resultJson, error,
  created_at as createdAt, updated_at as updatedAt, completed_at as completedAt
  FROM refresh_jobs`;

export async function requestRefreshJob(env: Env, input: {
  page: string;
  ticker?: string | null;
  requestedBy?: string;
  now?: Date;
}): Promise<RefreshJob> {
  const db = getOpsDb(env);
  const now = input.now ?? new Date();
  const page = input.page.trim().toLowerCase();
  const ticker = input.ticker?.trim().toUpperCase() || null;
  if (page === "market-commentary") {
    const active = await db.prepare(
      `${REFRESH_JOB_SELECT} WHERE page = ? AND ticker IS NULL AND status IN ('queued', 'running') ORDER BY created_at ASC LIMIT 1`,
    ).bind(page).first<RefreshJobRow>();
    if (active) return mapRow(active);
  }
  const idempotencyKey = refreshJobIdempotencyKey(page, ticker, now);
  await db.prepare(
    `INSERT OR IGNORE INTO refresh_jobs
       (id, idempotency_key, page, ticker, requested_by, status, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    idempotencyKey,
    page,
    ticker,
    input.requestedBy ?? "admin",
    now.toISOString(),
    now.toISOString(),
    now.toISOString(),
  ).run();
  const row = await db.prepare(
    `${REFRESH_JOB_SELECT} WHERE idempotency_key = ? LIMIT 1`,
  ).bind(idempotencyKey).first<RefreshJobRow>();
  if (!row) throw new Error("Refresh job could not be created.");
  const job = mapRow(row);
  await recordPipelineRun(env, job, { stage: "queued", status: "queued", now });
  return job;
}

export async function loadRefreshJob(env: Env, jobId: string): Promise<RefreshJob | null> {
  const row = await getOpsDb(env).prepare(
    `${REFRESH_JOB_SELECT} WHERE id = ? LIMIT 1`,
  ).bind(jobId).first<RefreshJobRow>();
  return row ? mapRow(row) : null;
}

export async function claimNextRefreshJob(env: Env, now = new Date()): Promise<RefreshJob | null> {
  const db = getOpsDb(env);
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + REFRESH_JOB_LEASE_MS).toISOString();
  const commentaryLeaseExpiresAt = new Date(now.getTime() + COMMENTARY_REFRESH_JOB_LEASE_MS).toISOString();
  await db.prepare(
    `UPDATE refresh_jobs
        SET status = 'failed',
            error = COALESCE(error, 'Refresh lease expired after maximum attempts.'),
            lease_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL,
            completed_at = ?, updated_at = ?
      WHERE status = 'running'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= ?
        AND attempt_count >= ?`,
  ).bind(now.toISOString(), now.toISOString(), now.toISOString(), REFRESH_JOB_MAX_ATTEMPTS).run();
  const row = await db.prepare(
    `UPDATE refresh_jobs
        SET status = 'running',
            attempt_count = attempt_count + 1,
            lease_token = ?,
            lease_expires_at = CASE WHEN page = 'market-commentary' THEN ? ELSE ? END,
            updated_at = ?
      WHERE id = (
        SELECT id FROM refresh_jobs
         WHERE (status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
            OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ? AND attempt_count < ?)
         ORDER BY CASE WHEN page = 'overview' THEN 0 ELSE 1 END, created_at ASC
         LIMIT 1
      )
      RETURNING id, page, ticker, status, attempt_count as attemptCount,
        lease_token as leaseToken, lease_expires_at as leaseExpiresAt,
        next_attempt_at as nextAttemptAt, result_json as resultJson, error,
        created_at as createdAt, updated_at as updatedAt, completed_at as completedAt`,
  ).bind(
    leaseToken,
    commentaryLeaseExpiresAt,
    leaseExpiresAt,
    now.toISOString(),
    now.toISOString(),
    now.toISOString(),
    REFRESH_JOB_MAX_ATTEMPTS,
  ).first<RefreshJobRow>();
  if (!row) return null;
  const job = mapRow(row);
  await recordPipelineRun(env, job, { stage: "executing", status: "running", now });
  return job;
}

export async function hasClaimableRefreshJob(env: Env, now = new Date()): Promise<boolean> {
  const row = await getOpsDb(env).prepare(
    `SELECT id
       FROM refresh_jobs
      WHERE (status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
         OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ? AND attempt_count < ?)
      ORDER BY CASE WHEN page = 'overview' THEN 0 ELSE 1 END, created_at ASC
      LIMIT 1`,
  ).bind(now.toISOString(), now.toISOString(), REFRESH_JOB_MAX_ATTEMPTS).first<{ id: string }>();
  return Boolean(row?.id);
}

export async function claimRefreshJobById(env: Env, jobId: string, now = new Date()): Promise<RefreshJob | null> {
  const db = getOpsDb(env);
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + REFRESH_JOB_LEASE_MS).toISOString();
  const commentaryLeaseExpiresAt = new Date(now.getTime() + COMMENTARY_REFRESH_JOB_LEASE_MS).toISOString();
  const row = await db.prepare(
    `UPDATE refresh_jobs
        SET status = 'running',
            attempt_count = attempt_count + 1,
            lease_token = ?,
            lease_expires_at = CASE WHEN page = 'market-commentary' THEN ? ELSE ? END,
            updated_at = ?
      WHERE id = ?
        AND ((status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
          OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ? AND attempt_count < ?))
      RETURNING id, page, ticker, status, attempt_count as attemptCount,
        lease_token as leaseToken, lease_expires_at as leaseExpiresAt,
        next_attempt_at as nextAttemptAt, result_json as resultJson, error,
        created_at as createdAt, updated_at as updatedAt, completed_at as completedAt`,
  ).bind(
    leaseToken,
    commentaryLeaseExpiresAt,
    leaseExpiresAt,
    now.toISOString(),
    jobId,
    now.toISOString(),
    now.toISOString(),
    REFRESH_JOB_MAX_ATTEMPTS,
  ).first<RefreshJobRow>();
  if (!row) return null;
  const job = mapRow(row);
  await recordPipelineRun(env, job, { stage: "executing", status: "running", now });
  return job;
}

export async function completeRefreshJob(
  env: Env,
  job: RefreshJob,
  result: NonNullable<RefreshJob["result"]>,
  now = new Date(),
): Promise<void> {
  await getOpsDb(env).prepare(
    `UPDATE refresh_jobs
        SET status = 'completed', result_json = ?, error = NULL,
            lease_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL,
            completed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND lease_token = ?`,
  ).bind(JSON.stringify(result), now.toISOString(), now.toISOString(), job.id, job.leaseToken).run();
  await recordPipelineRun(env, job, {
    stage: "completed",
    status: "completed",
    sessionDate: result.sessionDate ?? result.canonicalSession ?? null,
    completedCount: result.refreshedTickers,
    checkpoint: result,
    completedAt: now.toISOString(),
    now,
  });
}

export async function deferRefreshJob(
  env: Env,
  job: RefreshJob,
  delayMs = 5_000,
  now = new Date(),
): Promise<void> {
  const nextAttemptAt = new Date(now.getTime() + Math.max(1_000, delayMs)).toISOString();
  await getOpsDb(env).prepare(
    `UPDATE refresh_jobs
        SET status = 'queued', attempt_count = MAX(0, attempt_count - 1),
            error = NULL, lease_token = NULL, lease_expires_at = NULL,
            next_attempt_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND lease_token = ?`,
  ).bind(nextAttemptAt, now.toISOString(), job.id, job.leaseToken).run();
  await recordPipelineRun(env, job, { stage: "deferred", status: "queued", nextAttemptAt, now });
}

export async function failRefreshJob(
  env: Env,
  job: RefreshJob,
  error: unknown,
  now = new Date(),
): Promise<void> {
  const terminal = job.attemptCount >= REFRESH_JOB_MAX_ATTEMPTS;
  const nextAttemptAt = terminal
    ? null
    : new Date(now.getTime() + Math.min(15, 2 ** job.attemptCount) * 60_000).toISOString();
  const errorMessage = (error instanceof Error ? error.message : String(error ?? "Refresh failed")).slice(0, 1000);
  await getOpsDb(env).prepare(
    `UPDATE refresh_jobs
        SET status = ?, error = ?, lease_token = NULL, lease_expires_at = NULL,
            next_attempt_at = ?, completed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND lease_token = ?`,
  ).bind(
    terminal ? "failed" : "queued",
    errorMessage,
    nextAttemptAt,
    terminal ? now.toISOString() : null,
    now.toISOString(),
    job.id,
    job.leaseToken,
  ).run();
  await recordPipelineRun(env, job, {
    stage: terminal ? "failed" : "retry-wait",
    status: terminal ? "failed" : "queued",
    errorCode: terminal ? "refresh-attempts-exhausted" : "refresh-retryable-error",
    errorMessage,
    nextAttemptAt,
    completedAt: terminal ? now.toISOString() : null,
    now,
  });
}

export async function cleanupRefreshJobs(env: Env, now = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - 14 * 24 * 60 * 60_000).toISOString();
  const db = getOpsDb(env);
  for (let batch = 0; batch < 50; batch += 1) {
    const result = await db.prepare(
      `DELETE FROM refresh_jobs
        WHERE id IN (
          SELECT id FROM refresh_jobs
           WHERE status IN ('completed', 'failed') AND updated_at < ?
           ORDER BY updated_at LIMIT 250
        )`,
    ).bind(cutoff).run();
    const changes = Number(result.meta?.changes ?? result.meta?.rows_written ?? 0);
    if (changes < 250) return;
  }
}
