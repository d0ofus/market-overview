import { z } from "zod";
import { EOD_CONFIGURATION_KEY, eodConfigurationRecordSchema } from "./eod-recovery-status";
import { eodCutoverEvidenceSchema } from "./eod-rollout-service";
import { storageHash } from "./market-storage-pages";
import type { StorageMigrationRun } from "./market-storage-control";
import type { StorageBindingEvidence } from "./market-storage-activation";

export type EodProductionConfiguration = z.infer<typeof eodConfigurationRecordSchema>;
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const activationSchema = z.object({ version: z.literal(1), activatedAt: z.string().datetime({ offset: true }),
  codeRevision: z.string().regex(/^[a-f0-9]{40}$/), marketDatabaseId: z.string().uuid() }).strict();
function fail(reason: string): never { throw new Error(`storage-production-config-${reason}`); }

/** The operator CLI supplies authenticated observations, never file-provided
 * evidence. A later approved code revision keeps the original activation ID. */
export async function validateEodProductionConfiguration(input: {
  accountId: string; workerName: string; codeRevision: string; migrationId: string;
  marketDatabaseId: string; historyDatabaseId: string; opsDatabaseId: string;
  trackedConfig: unknown; githubMainRevision: string; githubVariables: ReadonlyMap<string, string>;
  migration: StorageMigrationRun | null; activation: unknown; codeApproval: unknown;
  binding: StorageBindingEvidence; now?: Date;
}): Promise<EodProductionConfiguration> {
  const now = input.now ?? new Date(), run = input.migration;
  if (!/^[a-f0-9]{40}$/.test(input.codeRevision) || input.githubMainRevision !== input.codeRevision) fail("checkout-revision-mismatch");
  if (!run || run.id !== input.migrationId || run.status !== "completed" || !run.completed_at
    || !Number.isFinite(Date.parse(run.completed_at)) || Date.parse(run.completed_at) > now.getTime()
    || run.target_database_id !== input.marketDatabaseId || run.history_database_id !== input.historyDatabaseId
    || new Set([run.source_database_id, run.target_database_id, run.history_database_id, input.opsDatabaseId]).size !== 4) fail("completed-migration-required");
  const activation = activationSchema.safeParse(input.activation);
  if (!activation.success || activation.data.codeRevision !== run.code_revision || activation.data.marketDatabaseId !== run.target_database_id
    || Date.parse(activation.data.activatedAt) > now.getTime()) fail("original-activation-mismatch");
  const approval = object(input.codeApproval), proof = eodCutoverEvidenceSchema.safeParse(approval?.proof);
  if (!approval || approval.version !== 1 || approval.codeRevision !== input.codeRevision || !proof.success
    || proof.data.codeRevision !== input.codeRevision || approval.methodologyVersion !== proof.data.methodologyVersion
    || typeof approval.approvedAt !== "string" || !Number.isFinite(Date.parse(approval.approvedAt))
    || Date.parse(approval.approvedAt) > now.getTime() || await storageHash(approval.proof) !== approval.proofHash) fail("current-code-approval-required");
  const config = object(input.trackedConfig), vars = object(config?.vars);
  if (!config || config.name !== input.workerName || (config.account_id !== undefined && config.account_id !== input.accountId)
    || vars?.EOD_RUNNER_MODE !== "active" || vars.EOD_READ_ENABLED !== "true" || !Array.isArray(config.d1_databases)) fail("tracked-canonical-config-required");
  const databases = config.d1_databases.map(object);
  if (databases.some((row) => !row) || new Set(databases.map((row) => row!.binding)).size !== databases.length) fail("tracked-bindings-ambiguous");
  for (const [binding, id] of [["MARKET_DATA_DB", input.marketDatabaseId], ["MARKET_HISTORY_DB", input.historyDatabaseId], ["OPS_DB", input.opsDatabaseId]]) {
    if (databases.find((row) => row!.binding === binding)?.database_id !== id) fail("tracked-database-mismatch");
  }
  if (vars.EOD_STORAGE_MIGRATION_ID !== undefined && vars.EOD_STORAGE_MIGRATION_ID !== run.id) fail("tracked-migration-mismatch");
  if (vars.EOD_CODE_REVISION !== undefined && vars.EOD_CODE_REVISION !== input.codeRevision) fail("tracked-code-revision-conflict");
  // A self-referential literal HEAD cannot be embedded in that same commit.
  // Deployments may supply the code SHA as a variable, independently verified below.
  for (const [name, value] of [["CLOUDFLARE_ACCOUNT_ID", input.accountId], ["EOD_MARKET_DATABASE_ID", input.marketDatabaseId],
    ["EOD_HISTORY_DATABASE_ID", input.historyDatabaseId], ["EOD_OPS_DATABASE_ID", input.opsDatabaseId],
    ["EOD_STORAGE_SOURCE_DATABASE_ID", run.source_database_id], ["EOD_RUNNER_MODE", "active"]]) {
    if (input.githubVariables.get(name) !== value) fail("github-canonical-config-mismatch");
  }
  const binding = input.binding, age = now.getTime() - Date.parse(binding.observedAt);
  if (binding.version !== 1 || binding.workerName !== input.workerName || binding.codeRevision !== input.codeRevision
    || binding.marketDatabaseId !== input.marketDatabaseId || binding.historyDatabaseId !== input.historyDatabaseId
    || binding.opsDatabaseId !== input.opsDatabaseId || !Number.isFinite(age) || age < 0 || age > 120_000) fail("serving-version-mismatch");
  return eodConfigurationRecordSchema.parse({ version: 1, codeRevision: input.codeRevision,
    activationCodeRevision: activation.data.codeRevision, recordedAt: now.toISOString(), marketDatabaseId: input.marketDatabaseId,
    migrationId: run.id, workerVersion: binding.versionId });
}

/** One business write after verification. Compare-and-swap prevents another
 * operator's record being overwritten; an identical replay keeps its date. */
export async function storeEodProductionConfiguration(ops: D1Database, input: EodProductionConfiguration): Promise<EodProductionConfiguration> {
  const record = eodConfigurationRecordSchema.parse(input);
  const previous = await ops.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?")
    .bind(EOD_CONFIGURATION_KEY).first<string>("evidence_json");
  if (previous) {
    let value: unknown;
    try { value = JSON.parse(previous); } catch { fail("previous-record-invalid"); }
    const parsed = eodConfigurationRecordSchema.safeParse(value);
    if (!parsed.success) fail("previous-record-invalid");
    if (parsed.data.migrationId !== record.migrationId || parsed.data.activationCodeRevision !== record.activationCodeRevision
      || parsed.data.marketDatabaseId !== record.marketDatabaseId) fail("previous-activation-conflict");
    if (Date.parse(parsed.data.recordedAt) > Date.parse(record.recordedAt)) fail("newer-record-exists");
    if (parsed.data.codeRevision === record.codeRevision && parsed.data.workerVersion === record.workerVersion) return parsed.data;
  }
  await ops.prepare(`INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES(?,?,?)
    ON CONFLICT(id) DO UPDATE SET evidence_json=excluded.evidence_json,updated_at=excluded.updated_at
    WHERE eod_rollout_evidence.evidence_json=?`)
    .bind(EOD_CONFIGURATION_KEY, JSON.stringify(record), record.recordedAt, previous).run();
  const stored = await ops.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?")
    .bind(EOD_CONFIGURATION_KEY).first<string>("evidence_json");
  if (stored !== JSON.stringify(record)) fail("record-write-conflict");
  return record;
}
