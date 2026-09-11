import { z } from "zod";
import { storageHash } from "./market-storage-pages";
import type { StorageMigrationIdentity } from "./market-storage-control";

const RUN_ID = /^[1-9]\d{0,19}$/;
const SHA = /^[a-f0-9]{40}$/;
const STORAGE_PATH = ".github/workflows/eod-storage-migration.yml";
const liveStatuses = ["queued", "in_progress", "waiting", "pending", "requested"] as const;
const snapshotSchema = z.object({
  repository: z.string(), workflowId: z.number().int().positive().safe(), checkSuiteId: z.number().int().positive().safe(), path: z.literal(STORAGE_PATH),
  runId: z.string().regex(RUN_ID), headRevision: z.string().regex(SHA), attempt: z.literal(1),
  event: z.literal("workflow_dispatch"), branch: z.literal("main"), status: z.literal("queued"), conclusion: z.null(),
  createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }),
  displayTitle: z.string().max(500), jobs: z.literal(0),
}).strict();
const recordSchema = z.object({
  version: z.literal(1), policy: z.literal("explicit-unallocated-storage-run-revocation-v1"),
  scope: z.literal("github-run-id-all-migrations"), dispatchInputsVerified: z.literal(false),
  operatorMigration: z.object({ id: z.string(), sourceDatabaseId: z.string().uuid(), targetDatabaseId: z.string().uuid(),
    historyDatabaseId: z.string().uuid(), sessionDate: z.string(), codeRevision: z.string().regex(SHA) }).strict(),
  fromRevision: z.string().regex(SHA), approvalRevision: z.string().regex(SHA),
  snapshot: snapshotSchema, firstCheckedAt: z.string().datetime({ offset: true }), secondCheckedAt: z.string().datetime({ offset: true }),
  evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
type Snapshot = z.infer<typeof snapshotSchema>;
type RecordEvidence = z.infer<typeof recordSchema>;
type GitHubReader = (path: string) => Promise<unknown>;
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
function fail(reason: string): never { throw new Error(`storage-execution-${reason}`); }

/** Run IDs are globally unique. A revoked unallocated dispatch is denied for
 * every migration, so unavailable GitHub inputs cannot weaken the fence. */
export function storageGitHubRevocationKey(runId: string): string {
  if (!RUN_ID.test(runId)) fail("github-run-id-invalid");
  return `storage-github-run-revoked:${runId}`;
}

export function validateUnallocatedStorageRun(input: {
  run: unknown; jobs: unknown; workflow: unknown; repository: string; runId: string; fromRevision: string;
}): Snapshot {
  const run = object(input.run), jobs = object(input.jobs), workflow = object(input.workflow);
  if (!run || !jobs || !workflow || !Number.isSafeInteger(run.id) || String(run.id) !== input.runId
    || run.workflow_id !== workflow.id || workflow.path !== STORAGE_PATH || run.path !== STORAGE_PATH
    || object(run.repository)?.full_name !== input.repository || object(run.head_repository)?.full_name !== input.repository
    || run.head_sha !== input.fromRevision || run.run_attempt !== 1 || run.event !== "workflow_dispatch"
    || run.head_branch !== "main" || run.status !== "queued" || run.conclusion !== null
    || jobs.total_count !== 0 || !Array.isArray(jobs.jobs) || jobs.jobs.length !== 0) fail("unallocated-run-evidence-invalid");
  const parsed = snapshotSchema.safeParse({ repository: input.repository, workflowId: run.workflow_id, checkSuiteId: run.check_suite_id, path: run.path,
    runId: input.runId, headRevision: run.head_sha, attempt: run.run_attempt, event: run.event, branch: run.head_branch,
    status: run.status, conclusion: run.conclusion, createdAt: run.created_at, updatedAt: run.updated_at,
    displayTitle: run.display_title, jobs: 0 });
  if (!parsed.success) fail("unallocated-run-evidence-invalid");
  return parsed.data;
}

async function loadRecord(ops: D1Database, key: string): Promise<RecordEvidence | null> {
  const text = await ops.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?").bind(key).first<string>("evidence_json");
  if (text === null) return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { fail("run-revocation-record-invalid"); }
  const parsed = recordSchema.safeParse(value);
  if (!parsed.success) fail("run-revocation-record-invalid");
  const { evidenceHash, ...unsigned } = parsed.data;
  if (await storageHash(unsigned) !== evidenceHash) fail("run-revocation-record-invalid");
  return parsed.data;
}

/** All noncompleted jobs still block. The only exception is an explicitly
 * named queued attempt whose exact metadata/jobs remain unchanged on both
 * sides of the complete active-state inventory, and whose denial is durable. */
export function createStorageWorkflowQuiescence(input: {
  ops: D1Database; repository: string; migration: StorageMigrationIdentity; fromRevision: string; codeRevision: string;
  revokeRunId?: string; readGitHub: GitHubReader; now?: () => Date;
}): () => Promise<void> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(input.repository) || !SHA.test(input.fromRevision) || !SHA.test(input.codeRevision)
    || (input.revokeRunId !== undefined && !RUN_ID.test(input.revokeRunId))) fail("run-revocation-identity-invalid");
  const migration = recordSchema.shape.operatorMigration.parse(input.migration);
  const root = `repos/${input.repository}/actions`, now = input.now ?? (() => new Date());
  const inspect = async (): Promise<Snapshot | null> => {
    if (input.revokeRunId === undefined) return null;
    const workflow = await input.readGitHub(`${root}/workflows/eod-storage-migration.yml`);
    const run = await input.readGitHub(`${root}/runs/${input.revokeRunId}`);
    // filter=all and attempt=1 prevent an older allocation from being hidden by
    // the jobs endpoint's default latest-attempt filtering.
    const jobs = await input.readGitHub(`${root}/runs/${input.revokeRunId}/jobs?filter=all&per_page=1`);
    return validateUnallocatedStorageRun({ workflow, run, jobs, repository: input.repository, runId: input.revokeRunId, fromRevision: input.fromRevision });
  };
  return async () => {
    const firstCheckedAt = now().toISOString(), before = await inspect();
    for (const workflow of ["eod-storage-migration.yml", "eod-market-data.yml"]) {
      const check = (value: unknown, status?: string) => {
        const body = object(value);
        if (!body || !Number.isSafeInteger(body.total_count) || Number(body.total_count) < 0 || !Array.isArray(body.workflow_runs)
          || body.workflow_runs.length > 100 || (status && body.total_count !== body.workflow_runs.length)) fail("workflow-inventory-invalid");
        for (const raw of body.workflow_runs) {
          const run = object(raw);
          if (!run || typeof run.status !== "string" || (status && run.status !== status)) fail("workflow-inventory-invalid");
          if (run.status === "completed") continue;
          if (!before || workflow !== "eod-storage-migration.yml" || String(run.id) !== before.runId
            || run.status !== "queued" || run.head_sha !== before.headRevision || run.run_attempt !== before.attempt
            || run.workflow_id !== before.workflowId) fail("workflow-writer-active");
        }
      };
      check(await input.readGitHub(`${root}/workflows/${workflow}/runs?per_page=100`));
      for (const status of liveStatuses) {
        check(await input.readGitHub(`${root}/workflows/${workflow}/runs?status=${status}&per_page=100`), status);
      }
    }
    const after = await inspect(), secondCheckedAt = now().toISOString();
    if (!before || !after || !input.revokeRunId) return;
    if (await storageHash(before) !== await storageHash(after)) fail("unallocated-run-evidence-changed");
    const key = storageGitHubRevocationKey(input.revokeRunId), existing = await loadRecord(input.ops, key);
    if (existing) {
      if (await storageHash(existing.snapshot) !== await storageHash(before) || existing.fromRevision !== input.fromRevision
        || existing.approvalRevision !== input.codeRevision || await storageHash(existing.operatorMigration) !== await storageHash(migration)) {
        fail("run-revocation-record-conflict");
      }
      return;
    }
    const unsigned = { version: 1 as const, policy: "explicit-unallocated-storage-run-revocation-v1" as const,
      scope: "github-run-id-all-migrations" as const, dispatchInputsVerified: false as const,
      operatorMigration: migration, fromRevision: input.fromRevision, approvalRevision: input.codeRevision,
      snapshot: before, firstCheckedAt, secondCheckedAt };
    const record = { ...unsigned, evidenceHash: await storageHash(unsigned) };
    recordSchema.parse(record);
    await input.ops.prepare("INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING")
      .bind(key, JSON.stringify(record), secondCheckedAt).run();
    const saved = await loadRecord(input.ops, key);
    if (!saved || saved.evidenceHash !== record.evidenceHash) fail("run-revocation-record-conflict");
  };
}
