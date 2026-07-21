import type { Env } from "./types";

const REFRESH_JOB_LEASE_MS = 2 * 60_000;
const REFRESH_JOB_DEDUPE_MS = 5 * 60_000;
const REFRESH_JOB_MAX_ATTEMPTS = 3;

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
  result: { page: string; refreshedTickers: number; notes?: string } | null;
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
  const now = input.now ?? new Date();
  const page = input.page.trim().toLowerCase();
  const ticker = input.ticker?.trim().toUpperCase() || null;
  const idempotencyKey = refreshJobIdempotencyKey(page, ticker, now);
  await env.DB.prepare(
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
  const row = await env.DB.prepare(
    `${REFRESH_JOB_SELECT} WHERE idempotency_key = ? LIMIT 1`,
  ).bind(idempotencyKey).first<RefreshJobRow>();
  if (!row) throw new Error("Refresh job could not be created.");
  return mapRow(row);
}

export async function loadRefreshJob(env: Env, jobId: string): Promise<RefreshJob | null> {
  const row = await env.DB.prepare(
    `${REFRESH_JOB_SELECT} WHERE id = ? LIMIT 1`,
  ).bind(jobId).first<RefreshJobRow>();
  return row ? mapRow(row) : null;
}

export async function claimNextRefreshJob(env: Env, now = new Date()): Promise<RefreshJob | null> {
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + REFRESH_JOB_LEASE_MS).toISOString();
  await env.DB.prepare(
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
  const row = await env.DB.prepare(
    `UPDATE refresh_jobs
        SET status = 'running',
            attempt_count = attempt_count + 1,
            lease_token = ?,
            lease_expires_at = ?,
            updated_at = ?
      WHERE id = (
        SELECT id FROM refresh_jobs
         WHERE (status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
            OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ? AND attempt_count < ?)
         ORDER BY created_at ASC
         LIMIT 1
      )
      RETURNING id, page, ticker, status, attempt_count as attemptCount,
        lease_token as leaseToken, lease_expires_at as leaseExpiresAt,
        next_attempt_at as nextAttemptAt, result_json as resultJson, error,
        created_at as createdAt, updated_at as updatedAt, completed_at as completedAt`,
  ).bind(
    leaseToken,
    leaseExpiresAt,
    now.toISOString(),
    now.toISOString(),
    now.toISOString(),
    REFRESH_JOB_MAX_ATTEMPTS,
  ).first<RefreshJobRow>();
  return row ? mapRow(row) : null;
}

export async function completeRefreshJob(
  env: Env,
  job: RefreshJob,
  result: NonNullable<RefreshJob["result"]>,
  now = new Date(),
): Promise<void> {
  await env.DB.prepare(
    `UPDATE refresh_jobs
        SET status = 'completed', result_json = ?, error = NULL,
            lease_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL,
            completed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND lease_token = ?`,
  ).bind(JSON.stringify(result), now.toISOString(), now.toISOString(), job.id, job.leaseToken).run();
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
  await env.DB.prepare(
    `UPDATE refresh_jobs
        SET status = ?, error = ?, lease_token = NULL, lease_expires_at = NULL,
            next_attempt_at = ?, completed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND lease_token = ?`,
  ).bind(
    terminal ? "failed" : "queued",
    (error instanceof Error ? error.message : String(error ?? "Refresh failed")).slice(0, 1000),
    nextAttemptAt,
    terminal ? now.toISOString() : null,
    now.toISOString(),
    job.id,
    job.leaseToken,
  ).run();
}

export async function cleanupRefreshJobs(env: Env, now = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - 14 * 24 * 60 * 60_000).toISOString();
  await env.DB.prepare(
    `DELETE FROM refresh_jobs
      WHERE status IN ('completed', 'failed')
        AND updated_at < ?`,
  ).bind(cutoff).run();
}
