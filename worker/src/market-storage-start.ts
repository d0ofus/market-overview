import { prepareStoragePreflight } from "./market-storage-preflight";
import type { StorageMigrationIdentity, StorageMigrationRun } from "./market-storage-control";

export type StorageStartDatabase = { id: string; name: string; bytes: number };
export type StorageStartInput = {
  accountId: string; sourceDatabaseId: string; historyDatabaseId: string; opsDatabaseId: string;
  migrationId: string; targetName: string; sessionDate: string; codeRevision: string;
  analysis: unknown; tickers: string[];
  snapshotSource: { accountId: string; sourceDatabaseId: string; runId: string }; now?: Date;
};
export type StorageStartDependencies = {
  assertCheckout(): Promise<void>;
  inspectSource(): Promise<{ schemaHash: string; coordinatorMigrationId: string | null }>;
  listDatabases(): Promise<StorageStartDatabase[]>;
  verifyGitHub(): Promise<{ targetDatabaseId: string | null; codeRevision: string | null }>;
  createDatabase(name: string): Promise<StorageStartDatabase>;
  loadRun(id: string): Promise<StorageMigrationRun | null>;
  assertEmptyTarget(id: string): Promise<void>;
  createRun(identity: StorageMigrationIdentity): Promise<void>;
  initializeHistory(): Promise<void>;
  authorizeRun(identity: StorageMigrationIdentity): Promise<void>;
  configureGitHub(sourceDatabaseId: string, targetDatabaseId: string, codeRevision: string): Promise<void>;
  deployCoordinator(migrationId: string): Promise<void>;
  verifyCoordinator(migrationId: string): Promise<void>;
  dispatch(migrationId: string): Promise<void>;
  journal(status: string, detail: { migrationId: string; targetDatabaseId?: string }): Promise<void>;
};
const uuid = (value: string) => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const unallocatedTarget = "00000000-0000-4000-8000-000000000000";

/** Older reviewed DDL was installed without a terminator before its accounting
 * comment, so SQLite retained that exact suffix in sqlite_schema. Ignore only
 * that known suffix; preserve quoted values and every substantive schema token. */
export function storageStartHistoryFenceSchemaMatches(actual: string, reviewed: string): boolean {
  const normalize = (sql: string) => sql.trim().replace(/\s*\/\* storage-reviewed-ddl \*\/$/, "").trim()
    .replace(/;$/, "").trim()
    .replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|\s+/g,
      (token) => /^\s/.test(token) ? " " : token)
    .replace(/^CREATE TABLE IF NOT EXISTS /i, "CREATE TABLE ");
  return normalize(actual) === normalize(reviewed);
}

/** Operator-only start protocol. Capacity validation precedes provisioning; the
 * canonical/public market binding never changes here. Every durable identity
 * lives in Ops. The journal is diagnostic and cannot authorize a replay. */
export async function startStorageMigrationOnce(input: StorageStartInput, deps: StorageStartDependencies) {
  if (!/^[a-f0-9]{32}$/i.test(input.accountId) || !/^[a-f0-9]{40}$/.test(input.codeRevision)
    || !/^market-storage:[A-Za-z0-9][A-Za-z0-9._:-]{0,104}$/.test(input.migrationId)
    || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.targetName)
    || ![input.sourceDatabaseId, input.historyDatabaseId, input.opsDatabaseId].every(uuid)
    || new Set([input.sourceDatabaseId, input.historyDatabaseId, input.opsDatabaseId]).size !== 3) {
    throw new Error("storage-start-identity-invalid");
  }
  await deps.assertCheckout();
  const source = await deps.inspectSource();
  if (source.coordinatorMigrationId && source.coordinatorMigrationId !== input.migrationId) {
    throw new Error("storage-start-another-coordinator-active");
  }
  const databases = await deps.listDatabases();
  if (databases.length > 10 || new Set(databases.map((row) => row.id)).size !== databases.length
    || databases.some((row) => !uuid(row.id) || !Number.isSafeInteger(row.bytes) || row.bytes < 0)
    || ![input.sourceDatabaseId, input.historyDatabaseId, input.opsDatabaseId].every((id) => databases.some((row) => row.id === id))) {
    throw new Error("storage-start-account-inventory-invalid");
  }
  const candidates = databases.filter((row) => row.name === input.targetName);
  if (candidates.length > 1 || (candidates[0] && [input.sourceDatabaseId, input.historyDatabaseId, input.opsDatabaseId].includes(candidates[0].id))) {
    throw new Error("storage-start-target-name-conflict");
  }
  const identity = (targetDatabaseId: string): StorageMigrationIdentity => ({ id: input.migrationId,
    sourceDatabaseId: input.sourceDatabaseId, targetDatabaseId, historyDatabaseId: input.historyDatabaseId,
    sessionDate: input.sessionDate, codeRevision: input.codeRevision });
  // The unallocated UUID is planning-only and never persisted or provisioned.
  // Repeat with Cloudflare's actual UUID immediately after creation.
  const preflight = await prepareStoragePreflight({ ...input, identity: identity(candidates[0]?.id ?? unallocatedTarget),
    sourceSchemaHash: source.schemaHash });
  const projectedAccountBytes = databases.reduce((sum, row) => sum + row.bytes, 0)
    - (candidates[0]?.bytes ?? 0) - databases.find((row) => row.id === input.historyDatabaseId)!.bytes
    + preflight.evidence.projectedRecentBytes + preflight.evidence.projectedArchiveBytes;
  if ((!candidates.length && databases.length >= 10) || !Number.isSafeInteger(projectedAccountBytes)
    || projectedAccountBytes >= 5_000_000_000) throw new Error("storage-start-free-account-capacity-exceeded");
  const github = await deps.verifyGitHub();
  if (github.targetDatabaseId && github.targetDatabaseId !== candidates[0]?.id) throw new Error("storage-start-github-target-conflict");
  if (github.codeRevision && github.codeRevision !== input.codeRevision) throw new Error("storage-start-github-revision-conflict");
  let existing = await deps.loadRun(input.migrationId);
  if (existing && (existing.source_database_id !== input.sourceDatabaseId || existing.target_database_id !== candidates[0]?.id
    || existing.history_database_id !== input.historyDatabaseId || existing.session_date !== input.sessionDate
    || existing.code_revision !== input.codeRevision || ["completed", "aborting", "aborted"].includes(existing.status))) {
    throw new Error("storage-start-durable-run-conflict");
  }
  await deps.assertCheckout();
  let target = candidates[0];
  if (!target) {
    target = await deps.createDatabase(input.targetName);
    if (!uuid(target.id) || target.name !== input.targetName || databases.some((row) => row.id === target!.id)) {
      throw new Error("storage-start-created-target-invalid");
    }
    await deps.journal("target-created", { migrationId: input.migrationId, targetDatabaseId: target.id }).catch(() => undefined);
  }
  const actualIdentity = identity(target.id);
  await prepareStoragePreflight({ ...input, identity: actualIdentity, sourceSchemaHash: source.schemaHash });
  if (existing?.freeze_authorized === 1 && source.coordinatorMigrationId === input.migrationId) {
    await deps.verifyCoordinator(input.migrationId);
    return { status: "already-started" as const, identity: actualIdentity };
  }
  if (existing?.freeze_authorized !== 1) {
    await deps.assertEmptyTarget(target.id);
    await deps.assertCheckout();
    await deps.createRun(actualIdentity);
    existing = await deps.loadRun(input.migrationId);
    if (!existing || existing.target_database_id !== target.id || existing.code_revision !== input.codeRevision) {
      throw new Error("storage-start-run-not-persisted");
    }
    await deps.initializeHistory();
    await deps.authorizeRun(actualIdentity);
    existing = await deps.loadRun(input.migrationId);
    if (!existing || existing.freeze_authorized !== 1 || existing.source_schema_hash !== source.schemaHash) {
      throw new Error("storage-start-freeze-authorization-not-persisted");
    }
  }
  await deps.assertCheckout();
  await deps.configureGitHub(input.sourceDatabaseId, target.id, input.codeRevision);
  await deps.deployCoordinator(input.migrationId);
  await deps.verifyCoordinator(input.migrationId);
  await deps.assertCheckout();
  await deps.dispatch(input.migrationId);
  await deps.journal("dispatch-accepted", { migrationId: input.migrationId, targetDatabaseId: target.id }).catch(() => undefined);
  return { status: "dispatch-accepted" as const, identity: actualIdentity, publicCutover: false };
}
