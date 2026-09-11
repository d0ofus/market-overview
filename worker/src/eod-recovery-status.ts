import { Hono } from "hono";
import { z } from "zod";
import { isAdminRequestAuthorized } from "./auth";
import { loadStorageMigration, storageExecutionRevision } from "./market-storage-control";
import { assertStorageExecutionRevision } from "./market-storage-execution";
import type { Env } from "./types";

export const EOD_CONTROLLER_STATUS_KEY = "recovery:local-controller";
export const EOD_CONFIGURATION_KEY = "recovery:production-configuration";
const revision = z.string().regex(/^[a-f0-9]{40}$/);
const timestamp = z.string().datetime({ offset: true });
export const eodControllerReportSchema = z.object({
  version: z.literal(1), status: z.enum(["running", "waiting", "paused", "completed"]),
  stage: z.string().regex(/^[a-z0-9-]{1,100}$/), reason: z.string().regex(/^[a-z0-9-]{0,150}$/),
  nextAttemptAt: timestamp.nullable(), updatedAt: timestamp, codeRevision: revision,
}).strict();
export type EodControllerReport = z.infer<typeof eodControllerReportSchema>;
const activationSchema = z.object({ version: z.literal(1), activatedAt: timestamp, codeRevision: revision,
  marketDatabaseId: z.string().uuid() }).strict();
export const eodConfigurationRecordSchema = z.object({ version: z.literal(1), codeRevision: revision,
  activationCodeRevision: revision, recordedAt: timestamp, marketDatabaseId: z.string().uuid(),
  migrationId: z.string().regex(/^market-storage:[A-Za-z0-9._:-]+$/), workerVersion: z.string().uuid(),
}).strict();
function json(value: string | undefined): unknown {
  try { return value ? JSON.parse(value) : null; } catch { return null; }
}

/** Diagnostic publication only. It cannot approve migration or public cutover.
 * Preserve observation time on identical retries; reject older reports. */
export async function storeEodControllerReport(ops: D1Database, input: unknown, now = new Date()): Promise<void> {
  const report = eodControllerReportSchema.parse(input);
  if (Date.parse(report.updatedAt) > now.getTime()) throw new Error("eod-recovery-report-future");
  const payload = JSON.stringify(report);
  const previous = await ops.prepare("SELECT evidence_json,updated_at FROM eod_rollout_evidence WHERE id=?")
    .bind(EOD_CONTROLLER_STATUS_KEY).first<{ evidence_json: string; updated_at: string }>();
  if (previous?.evidence_json === payload || (previous && Date.parse(previous.updated_at) > Date.parse(report.updatedAt))) return;
  await ops.prepare(`INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES(?,?,?)
    ON CONFLICT(id) DO UPDATE SET evidence_json=excluded.evidence_json,updated_at=excluded.updated_at
    WHERE julianday(excluded.updated_at)>=julianday(eod_rollout_evidence.updated_at)`)
    .bind(EOD_CONTROLLER_STATUS_KEY, payload, report.updatedAt).run();
}

export async function loadEodRecoveryStatus(env: Env, now = new Date()) {
  if (!env.OPS_DB) throw new Error("eod-recovery-ops-unavailable");
  const rows = await env.OPS_DB.prepare("SELECT id,evidence_json FROM eod_rollout_evidence WHERE id IN (?,?,?)")
    .bind(EOD_CONTROLLER_STATUS_KEY, EOD_CONFIGURATION_KEY, "monitoring:public-activation")
    .all<{ id: string; evidence_json: string }>();
  const records = new Map(rows.results.map((row) => [row.id, json(row.evidence_json)]));
  const controller = eodControllerReportSchema.safeParse(records.get(EOD_CONTROLLER_STATUS_KEY));
  const activation = activationSchema.safeParse(records.get("monitoring:public-activation"));
  const configuration = eodConfigurationRecordSchema.safeParse(records.get(EOD_CONFIGURATION_KEY));
  const migration = env.EOD_STORAGE_MIGRATION_ID ? await loadStorageMigration(env.OPS_DB, env.EOD_STORAGE_MIGRATION_ID) : null;
  if (migration?.execution_revision) await assertStorageExecutionRevision(env.OPS_DB,migration,storageExecutionRevision(migration));
  const active = activation.success && Date.parse(activation.data.activatedAt) <= now.getTime() ? activation.data : null;
  const verifiedCutover = Boolean(migration?.status === "completed" && active
    && active.marketDatabaseId === migration.target_database_id && active.codeRevision === storageExecutionRevision(migration)
    && env.EOD_RUNNER_MODE === "active" && env.EOD_READ_ENABLED === "true");
  const recorded = configuration.success && active && verifiedCutover
    && configuration.data.migrationId === migration?.id && configuration.data.marketDatabaseId === migration?.target_database_id
    && configuration.data.activationCodeRevision === active.codeRevision && configuration.data.codeRevision === env.EOD_CODE_REVISION
    && Date.parse(configuration.data.recordedAt) <= now.getTime();
  const report = controller.success && Date.parse(controller.data.updatedAt) <= now.getTime() ? controller.data : null;
  const verifiedCompleted = report?.status === "completed" && verifiedCutover && report.codeRevision === active?.codeRevision;
  const expectedHeartbeat = report?.status === "waiting" && report.nextAttemptAt
    ? Math.max(Date.parse(report.updatedAt), Date.parse(report.nextAttemptAt)) : Date.parse(report?.updatedAt ?? "");
  return {
    checkedAt: now.toISOString(),
    controller: report ? { ...report, stale: !verifiedCompleted && now.getTime() - expectedHeartbeat > 90 * 60_000 } : null,
    configuration: { status: recorded ? "recorded" as const : records.has(EOD_CONFIGURATION_KEY) ? "mismatch" as const : "pending" as const,
      codeRevision: configuration.success ? configuration.data.codeRevision : null,
      activationCodeRevision: configuration.success ? configuration.data.activationCodeRevision : null,
      recordedAt: configuration.success ? configuration.data.recordedAt : null },
    activation: active && verifiedCutover ? { activatedAt: active.activatedAt, codeRevision: active.codeRevision } : null,
  };
}

export function registerEodRecoveryRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get("/api/admin/eod/recovery-status", async (c) => {
    if (!c.env.ADMIN_SECRET || !isAdminRequestAuthorized(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
    c.header("Cache-Control", "no-store");
    try { return c.json(await loadEodRecoveryStatus(c.env)); }
    catch { return c.json({ error: "Recovery status could not be verified. Retry after database access recovers." }, 503); }
  });
}
