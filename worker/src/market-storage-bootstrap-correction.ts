import { eodHash } from "./eod-publication-service";
import type { EodRun } from "./eod-coordinator";
import type { FrozenInputs } from "./eod-runner";
import type { Env } from "./types";

/** A completed private daily run can become outdated in the same session.
 * Reconstruct its corrected revision under the existing migration owner;
 * preserve all accepted publications and the exact measured input manifest. */
export async function requeueStorageBootstrapCorrection(env: Env, input: {
  migrationId: string; migrationLeaseToken: string; planHash: string;
  targetDatabaseId: string; runId: string; sessionDate: string; plannedInputs: FrozenInputs; now?: Date;
}): Promise<EodRun> {
  const now = input.now ?? new Date(), timestamp = now.toISOString(), ops = env.OPS_DB;
  if (!ops || !env.MARKET_DATA_DB || env.EOD_RUNNER_MODE !== "active" || env.EOD_ARCHIVE_PRUNE_ENABLED !== "false"
    || input.runId !== `eod:active:${input.sessionDate}:daily` || !/^[a-f0-9]{64}$/.test(input.planHash)
    || input.plannedInputs.calendarDates.at(-1) !== input.sessionDate) throw new Error("storage-bootstrap-correction-identity-invalid");
  const current = await ops.prepare("SELECT * FROM eod_runs WHERE id=?").bind(input.runId).first<EodRun>();
  if (!current || current.id !== input.runId || current.mode !== "active" || current.purpose !== "daily" || current.session_date !== input.sessionDate) {
    throw new Error("storage-bootstrap-correction-run-mismatch");
  }
  if (current.status !== "completed") return current;
  let frozen: unknown;
  try { frozen = JSON.parse(current.input_json); } catch { throw new Error("storage-bootstrap-correction-inputs-invalid"); }
  if (await eodHash(frozen) !== await eodHash(input.plannedInputs)) throw new Error("storage-bootstrap-correction-inputs-mismatch");
  const revision = await env.MARKET_DATA_DB.prepare("SELECT revision FROM eod_input_clock WHERE id='default'").first<number>("revision");
  if (revision === null || !Number.isSafeInteger(revision) || revision < 0 || typeof current.completed_input_clock !== "number"
    || !Number.isSafeInteger(current.completed_input_clock) || current.completed_input_clock < 0 || revision < current.completed_input_clock) {
    throw new Error("storage-bootstrap-correction-clock-invalid");
  }
  if (revision === current.completed_input_clock) return current;
  const reset = await ops.prepare(`UPDATE eod_runs SET status='queued',stage='inputs',completed_at=NULL,completed_input_clock=NULL,
    next_attempt_at=?,error_code=NULL,error_message=NULL,lease_token=NULL,lease_until=NULL,updated_at=?
    WHERE id=? AND mode='active' AND purpose='daily' AND status='completed' AND completed_input_clock=? AND input_json=?
      AND (lease_until IS NULL OR lease_until<=?)
      AND EXISTS(SELECT 1 FROM market_storage_migrations WHERE id=? AND target_database_id=?
        AND status='running' AND lease_token=? AND lease_until>?)
      AND EXISTS(SELECT 1 FROM market_storage_checkpoints WHERE migration_id=? AND checkpoint_key='bootstrap:owner'
        AND input_hash=? AND json_extract(payload_json,'$.runId')=? AND json_extract(payload_json,'$.sessionDate')=?
        AND json_extract(payload_json,'$.targetDatabaseId')=?) RETURNING id`)
    .bind(timestamp,timestamp,input.runId,current.completed_input_clock,current.input_json,timestamp,
      input.migrationId,input.targetDatabaseId,input.migrationLeaseToken,timestamp,input.migrationId,input.planHash,input.runId,input.sessionDate,input.targetDatabaseId).first();
  if (!reset) throw new Error("storage-bootstrap-correction-owner-conflict");
  const updated = await ops.prepare("SELECT * FROM eod_runs WHERE id=?").bind(input.runId).first<EodRun>();
  if (!updated || updated.status !== "queued" || updated.input_json !== current.input_json || updated.completed_input_clock !== null) {
    throw new Error("storage-bootstrap-correction-reset-not-persisted");
  }
  return updated;
}
