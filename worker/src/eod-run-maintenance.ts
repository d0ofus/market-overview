import { getOpsDb } from "./ops-db";
import type { Env } from "./types";

const TERMINAL = "'completed','failed','cancelled','expired'";

/** Explicit runner maintenance. Bounded deletes include index/trigger costs in normal D1 admission. */
export async function cleanupEodRunState(env: Env, input: { maxRows?: number; now?: Date } = {}): Promise<{
  checkpointsDeleted: number; reservationsDeleted: number; runsDeleted: number; summariesCompacted: number;
}> {
  const db = getOpsDb(env);
  const now = input.now ?? new Date();
  const maxRows = Math.min(5_000, Math.max(1, Math.trunc(input.maxRows ?? 1_000)));
  const chunks = <T>(rows: T[]) => Array.from({ length: Math.ceil(rows.length / 500) }, (_, index) => rows.slice(index * 500, (index + 1) * 500));
  if (!Number.isFinite(maxRows) || !Number.isFinite(now.getTime())) throw new Error("Invalid EOD retention bounds.");
  const oldRunDate = new Date(now.getTime() - 35 * 86_400_000).toISOString().slice(0, 10);
  const oldReservationTime = new Date(now.getTime() - 2 * 86_400_000).toISOString();
  const sessions = (await db.prepare("SELECT DISTINCT session_date as date FROM eod_runs WHERE status='completed' ORDER BY session_date DESC LIMIT 2")
    .all<{ date: string }>()).results ?? [];
  const completedCutoff = sessions.length === 2 ? sessions[1].date : "0001-01-01";
  const checkpointRows = (await db.prepare(`SELECT c.run_id as runId,c.chunk_key as chunkKey
    FROM eod_runs r JOIN eod_checkpoints c ON c.run_id=r.id
    WHERE (r.status='completed' AND r.session_date < ?)
       OR (r.status IN (${TERMINAL}) AND r.session_date < ?)
       OR (r.session_date < ? AND c.chunk_key LIKE 'features:%'
         AND (r.lease_until IS NULL OR r.lease_until<=?))
    ORDER BY r.session_date,c.run_id,c.chunk_key LIMIT ?`)
    .bind(completedCutoff, oldRunDate, oldRunDate, now.toISOString(), maxRows).all<{ runId: string; chunkKey: string }>()).results ?? [];
  let checkpointsDeleted = 0;
  for (const group of chunks(checkpointRows)) {
    const result = await db.prepare(`DELETE FROM eod_checkpoints
      WHERE (run_id,chunk_key) IN (SELECT json_extract(value,'$.runId'),json_extract(value,'$.chunkKey') FROM json_each(?)) AND EXISTS (
      SELECT 1 FROM eod_runs r WHERE r.id=eod_checkpoints.run_id
      AND ((r.status='completed' AND r.session_date < ?) OR (r.status IN (${TERMINAL}) AND r.session_date < ?)
        OR (r.session_date < ? AND eod_checkpoints.chunk_key LIKE 'features:%'
          AND (r.lease_until IS NULL OR r.lease_until<=?))))`)
      .bind(JSON.stringify(group), completedCutoff, oldRunDate, oldRunDate, now.toISOString()).run();
    checkpointsDeleted += Number(result.meta?.changes ?? 0);
  }
  const reservations = (await db.prepare(`SELECT id FROM eod_budget_reservations
    WHERE settled=1 AND created_at < ? ORDER BY created_at,id LIMIT ?`)
    .bind(oldReservationTime, maxRows).all<{ id: string }>()).results ?? [];
  let reservationsDeleted = 0;
  for (const group of chunks(reservations)) {
    const result = await db.prepare("DELETE FROM eod_budget_reservations WHERE id IN (SELECT value FROM json_each(?)) AND settled=1 AND created_at < ?")
      .bind(JSON.stringify(group.map((row) => row.id)), oldReservationTime).run();
    reservationsDeleted += Number(result.meta?.changes ?? 0);
  }
  const terminalRuns = (await db.prepare(`SELECT id,deadline_missed as missedDeadline FROM eod_runs r
    WHERE status IN (${TERMINAL}) AND session_date < ?
      AND NOT EXISTS (SELECT 1 FROM eod_checkpoints c WHERE c.run_id=r.id)
      AND (deadline_missed=0 OR input_json<>'{}' OR COALESCE(json_extract(progress_json,'$.retentionSummary'),0)<>1)
    ORDER BY session_date,id LIMIT ?`).bind(oldRunDate, maxRows).all<{ id: string; missedDeadline: number }>()).results ?? [];
  let runsDeleted = 0;
  let summariesCompacted = 0;
  for (const group of chunks(terminalRuns.filter((run) => Number(run.missedDeadline)))) {
      const result = await db.prepare(`UPDATE eod_runs SET input_json='{}',
        progress_json=json_object('retentionSummary',1,'deadlineMissed',1,'compactedAt',?)
        WHERE id IN (SELECT value FROM json_each(?)) AND status IN (${TERMINAL}) AND session_date < ? AND deadline_missed<>0`)
        .bind(now.toISOString(), JSON.stringify(group.map((row) => row.id)), oldRunDate).run();
      summariesCompacted += Number(result.meta?.changes ?? 0);
  }
  for (const group of chunks(terminalRuns.filter((run) => !Number(run.missedDeadline)))) {
      const result = await db.prepare(`DELETE FROM eod_runs WHERE id IN (SELECT value FROM json_each(?)) AND status IN (${TERMINAL})
        AND session_date < ? AND deadline_missed=0 AND NOT EXISTS (SELECT 1 FROM eod_checkpoints WHERE run_id=eod_runs.id)`)
        .bind(JSON.stringify(group.map((row) => row.id)), oldRunDate).run();
      runsDeleted += Number(result.meta?.changes ?? 0);
  }
  return { checkpointsDeleted, reservationsDeleted, runsDeleted, summariesCompacted };
}
