import { z } from "zod";
import { storageHash } from "./market-storage-pages";
import { assertStorageSourceFrozen } from "./market-storage-fence";
import { loadStorageMigration, storageExecutionIdentity, storageExecutionRevision, storageMigrationIdentity, type StorageMigrationRun, type StorageMigrationIdentity } from "./market-storage-control";

const sha = z.string().regex(/^[a-f0-9]{40}$/), hash = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.object({ id: z.string(), sourceDatabaseId: z.string().uuid(), targetDatabaseId: z.string().uuid(),
  historyDatabaseId: z.string().uuid(), sessionDate: z.string(), codeRevision: sha }).strict();
const unsignedSchema = z.object({ version: z.literal(1), policy: z.literal("preserve-storage-capture-execution-v1"),
  storageIdentity: identity, fromRevision: sha, codeRevision: sha, predecessorHash: hash.nullable(),
  sourceCapture: z.object({ schemaHash: hash, revision: z.number().int().nonnegative().safe() }).strict(),
  freezeEvidenceHash: hash, checkpointCount: z.number().int().nonnegative().safe(), checkpointManifestHash: hash,
  changedFiles: z.array(z.string()).max(500), diffHash: hash, approvedAt: z.string().datetime({ offset: true }),
  storagePolicy: z.object({ hotSessions: z.literal(90), marketBytes: z.literal(350_000_000), archiveBytes: z.literal(350_000_000),
    databaseCount: z.literal(10), accountBytes: z.literal(5_000_000_000) }).strict(),
}).strict();
const recordSchema = unsignedSchema.extend({ evidenceHash: hash }).strict();
export type StorageExecutionRecord = z.infer<typeof recordSchema>;
export const storageExecutionKey = (id: string, revision: string) => `storage-execution:${id}:${revision}`;
function fail(reason: string): never { throw new Error(`storage-execution-${reason}`); }

export async function validateStorageExecutionEvidence(value: unknown, run: StorageMigrationRun, actualRevision: string): Promise<StorageExecutionRecord|null> {
  if (!sha.safeParse(actualRevision).success || storageExecutionRevision(run) !== actualRevision) fail("revision-not-approved");
  if (actualRevision === run.code_revision && !run.execution_revision && !run.execution_evidence_hash) return null;
  if (!run.execution_revision || !run.execution_evidence_hash) fail("lineage-incomplete");
  const parsed = recordSchema.safeParse(value);
  if (!parsed.success) fail("record-invalid");
  const { evidenceHash, ...unsigned } = parsed.data;
  if (await storageHash(unsigned) !== evidenceHash || evidenceHash !== run.execution_evidence_hash
    || parsed.data.codeRevision !== actualRevision || await storageHash(parsed.data.storageIdentity) !== await storageHash(storageMigrationIdentity(run))
    || parsed.data.sourceCapture.schemaHash !== run.source_schema_hash || parsed.data.sourceCapture.revision !== run.source_revision
    || parsed.data.freezeEvidenceHash !== run.freeze_evidence_hash
    || Date.parse(parsed.data.approvedAt) > Date.now()) fail("record-integrity");
  return parsed.data;
}

export async function assertStorageExecutionRevision(ops: D1Database, run: StorageMigrationRun, actualRevision: string): Promise<StorageExecutionRecord|null> {
  if (!sha.safeParse(actualRevision).success || storageExecutionRevision(run) !== actualRevision) fail("revision-not-approved");
  if (actualRevision === run.code_revision && !run.execution_revision && !run.execution_evidence_hash) return null;
  if (!run.execution_revision || !run.execution_evidence_hash) fail("lineage-incomplete");
  const text = await ops.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?")
    .bind(storageExecutionKey(run.id, actualRevision)).first<string>("evidence_json");
  let value: unknown; try { value = JSON.parse(text ?? "null"); } catch { fail("record-invalid"); }
  return validateStorageExecutionEvidence(value,run,actualRevision);
}

export async function resolveStorageExecutionIdentity(ops: D1Database, storageIdentity: StorageMigrationIdentity, actualRevision: string): Promise<{
  identity: StorageMigrationIdentity; record: StorageExecutionRecord|null;
}> {
  if (actualRevision === storageIdentity.codeRevision) return { identity: storageIdentity, record: null };
  const run = await loadStorageMigration(ops,storageIdentity.id);
  const parsedIdentity = identity.safeParse(storageIdentity);
  if (!run || !parsedIdentity.success || await storageHash(storageMigrationIdentity(run)) !== await storageHash(parsedIdentity.data)) fail("storage-identity-mismatch");
  const record = await assertStorageExecutionRevision(ops,run,actualRevision);
  return { identity: storageExecutionIdentity(run), record };
}

/** The CLI obtains Git/remote-main facts and supplies quiescence rechecks.
 * Only Ops changes: captures, fence ownership, archive pointers and checkpoint
 * payloads/hashes remain byte-identical. Promotion pauses until GitHub is pinned. */
export async function approveStorageExecutionTransition(input: {
  ops: D1Database; source: D1Database; migrationId: string; fromRevision: string; codeRevision: string;
  changedFiles: string[]; diffHash: string; assertReviewedCheckout: () => Promise<void>;
  assertNoWorkflowWriters: () => Promise<void>; now?: Date;
}): Promise<StorageExecutionRecord> {
  const now = input.now ?? new Date();
  if (!sha.safeParse(input.fromRevision).success || !sha.safeParse(input.codeRevision).success
    || input.fromRevision === input.codeRevision || !hash.safeParse(input.diffHash).success) fail("revision-invalid");
  await input.assertReviewedCheckout(); await input.assertNoWorkflowWriters();
  const run = await loadStorageMigration(input.ops, input.migrationId);
  if (!run || ["completed", "aborted", "aborting", "awaiting-cutover", "dispatched", "dispatching"].includes(run.status)
    || run.freeze_authorized !== 1 || !run.freeze_evidence_hash || !run.source_schema_hash || run.source_revision === null) fail("migration-not-transitionable");
  if (run.execution_revision === input.codeRevision) {
    const record = await assertStorageExecutionRevision(input.ops, run, input.codeRevision);
    if (!record || record.fromRevision !== input.fromRevision || record.diffHash !== input.diffHash) fail("existing-record-conflict");
    return record;
  }
  await assertStorageExecutionRevision(input.ops, run, input.fromRevision);
  const timestamp = now.toISOString();
  const checkWriters = async () => {
    if ((run.lease_until && run.lease_until > timestamp) || run.dispatch_token
      || await input.ops.prepare("SELECT id FROM eod_runs WHERE lease_until>? LIMIT 1").bind(timestamp).first()) fail("live-writer");
  };
  await checkWriters();
  const sourceCapture = await assertStorageSourceFrozen(input.source, storageMigrationIdentity(run), run.source_schema_hash);
  if (sourceCapture.revision !== run.source_revision) fail("source-capture-changed");
  const preflightText = await input.ops.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?")
    .bind(`storage-preflight:${run.id}`).first<string>("evidence_json");
  let preflight: { hash?: string; evidence?: { hotSessions?: number } };
  try { preflight = JSON.parse(preflightText ?? "null"); } catch { fail("preflight-invalid"); }
  if (!preflight?.evidence || preflight.hash !== run.freeze_evidence_hash || await storageHash(preflight.evidence) !== preflight.hash
    || preflight.evidence.hotSessions !== 90) fail("ninety-session-preflight-required");
  // Existing runtime/bootstrap proof cannot be silently reassigned to new code.
  if (await input.ops.prepare("SELECT checkpoint_key FROM market_storage_checkpoints WHERE migration_id=? AND (checkpoint_key LIKE 'bootstrap:%' OR checkpoint_key='consumer-parity:complete') LIMIT 1")
    .bind(run.id).first()) fail("late-transition-requires-new-validation");
  let after = "", checkpointCount = 0, checkpointManifestHash = await storageHash([]);
  for (;;) {
    const rows = await input.ops.prepare("SELECT checkpoint_key,input_hash,payload_json FROM market_storage_checkpoints WHERE migration_id=? AND checkpoint_key>? ORDER BY checkpoint_key LIMIT 100")
      .bind(run.id, after).all<{ checkpoint_key: string; input_hash: string; payload_json: string }>();
    for (const row of rows.results) {
      checkpointManifestHash = await storageHash([checkpointManifestHash, row.checkpoint_key, row.input_hash, await storageHash(row.payload_json)]);
      checkpointCount++;
    }
    if (checkpointCount > 20_000) fail("checkpoint-manifest-exceeds-bound");
    if (rows.results.length < 100) break;
    after = rows.results.at(-1)!.checkpoint_key;
  }
  const unsigned = unsignedSchema.parse({ version: 1, policy: "preserve-storage-capture-execution-v1", storageIdentity: storageMigrationIdentity(run),
    fromRevision: input.fromRevision, codeRevision: input.codeRevision, predecessorHash: run.execution_evidence_hash ?? null,
    sourceCapture, freezeEvidenceHash: run.freeze_evidence_hash, checkpointCount, checkpointManifestHash,
    changedFiles: [...input.changedFiles].sort(), diffHash: input.diffHash, approvedAt: timestamp,
    storagePolicy: { hotSessions: 90, marketBytes: 350_000_000, archiveBytes: 350_000_000, databaseCount: 10, accountBytes: 5_000_000_000 } });
  const record = { ...unsigned, evidenceHash: await storageHash(unsigned) }, key = storageExecutionKey(run.id, input.codeRevision);
  await input.assertReviewedCheckout(); await input.assertNoWorkflowWriters(); await checkWriters();
  await assertStorageSourceFrozen(input.source, storageMigrationIdentity(run), run.source_schema_hash);
  const payload = JSON.stringify(record);
  const results = await input.ops.batch([
    input.ops.prepare("INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING").bind(key,payload,timestamp),
    input.ops.prepare(`UPDATE market_storage_migrations SET execution_revision=?,execution_evidence_hash=?,status='awaiting-evidence',
      error_code='storage-execution-github-pin-required',next_attempt_at=NULL,lease_token=NULL,lease_until=NULL,updated_at=?
      WHERE id=? AND COALESCE(execution_revision,code_revision)=? AND code_revision=? AND freeze_evidence_hash=?
        AND source_schema_hash=? AND source_revision=? AND updated_at=? AND stage=? AND status IN ('queued','retrying','running','awaiting-evidence')
        AND (lease_until IS NULL OR lease_until<=?) AND dispatch_token IS NULL
        AND NOT EXISTS(SELECT 1 FROM eod_runs WHERE lease_until>?)
        AND EXISTS(SELECT 1 FROM eod_rollout_evidence WHERE id=? AND evidence_json=?) RETURNING id`)
      .bind(input.codeRevision,record.evidenceHash,timestamp,run.id,input.fromRevision,run.code_revision,run.freeze_evidence_hash,
        run.source_schema_hash,run.source_revision,run.updated_at,run.stage,timestamp,timestamp,key,payload),
  ]);
  if (results[1]?.results.length !== 1) fail("promotion-conflict");
  const saved = await loadStorageMigration(input.ops,run.id);
  if (!saved) fail("migration-missing");
  return (await assertStorageExecutionRevision(input.ops,saved,input.codeRevision))!;
}
