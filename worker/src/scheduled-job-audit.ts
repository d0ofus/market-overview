import type { ScheduledLane } from "./scheduled-budget";
import { getOpsDb } from "./ops-db";
import type { Env } from "./types";

export type ScheduledJobAuditStatus = "started" | "skipped" | "completed" | "failed";

function isScheduledJobAuditUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /scheduled_job_runs|no such table|no such column|\.run is not a function/i.test(message);
}

export async function startScheduledJobRun(
  env: Env,
  input: {
    lane: ScheduledLane;
    cron: string | null | undefined;
    jobKey: string;
    scheduledTime: string;
    metadata?: Record<string, unknown> | null;
  },
): Promise<string | null> {
  try {
    const db = getOpsDb(env);
    const id = crypto.randomUUID();
    await db.prepare(
      `INSERT INTO scheduled_job_runs
        (id, lane, cron, job_key, scheduled_time, status, reason, metadata_json, started_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'started', NULL, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    )
      .bind(
        id,
        input.lane,
        input.cron ?? null,
        input.jobKey,
        input.scheduledTime,
        input.metadata ? JSON.stringify(input.metadata) : null,
      )
      .run();
    return id;
  } catch (error) {
    if (!isScheduledJobAuditUnavailable(error)) {
      console.warn("scheduled job audit start failed", { jobKey: input.jobKey, error });
    }
    return null;
  }
}

export async function finishScheduledJobRun(
  env: Env,
  id: string | null,
  status: ScheduledJobAuditStatus,
  reason?: string | null,
  metadata?: Record<string, unknown> | null,
): Promise<void> {
  if (!id) return;
  try {
    await getOpsDb(env).prepare(
      `UPDATE scheduled_job_runs
          SET status = ?,
              reason = ?,
              metadata_json = COALESCE(?, metadata_json),
              completed_at = CASE WHEN ? IN ('completed', 'failed', 'skipped') THEN CURRENT_TIMESTAMP ELSE completed_at END,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
    )
      .bind(status, reason ?? null, metadata ? JSON.stringify(metadata) : null, status, id)
      .run();
  } catch (error) {
    if (!isScheduledJobAuditUnavailable(error)) {
      console.warn("scheduled job audit finish failed", { id, status, error });
    }
  }
}
