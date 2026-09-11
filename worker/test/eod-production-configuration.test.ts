import { describe, expect, it } from "vitest";
import { storeEodProductionConfiguration, validateEodProductionConfiguration } from "../src/eod-production-configuration";
import { EOD_CONFIGURATION_KEY } from "../src/eod-recovery-status";
import { EOD_PUBLICATION_SCOPES } from "../src/eod-coordinator";
import { EOD_METRICS_VERSION } from "../src/eod-metrics";
import type { StorageMigrationRun } from "../src/market-storage-control";
import type { EodCutoverEvidence } from "../src/eod-rollout-service";
import { storageHash } from "../src/market-storage-pages";
import { createSqliteD1 } from "./helpers/sqlite-d1";

const source = "10000000-0000-4000-8000-000000000001", target = "10000000-0000-4000-8000-000000000002";
const history = "10000000-0000-4000-8000-000000000003", ops = "10000000-0000-4000-8000-000000000004";
const workerVersion = "10000000-0000-4000-8000-000000000005", deploymentId = "10000000-0000-4000-8000-000000000006";
const originalRevision = "a".repeat(40), currentRevision = "b".repeat(40), stamp = "2026-09-10T02:00:00Z";
async function fixture() {
  const proof: EodCutoverEvidence = { version: 1, codeRevision: currentRevision, methodologyVersion: EOD_METRICS_VERSION,
    measuredAt: stamp, sessionDate: "2026-09-09", runId: "eod:active:2026-09-09:daily", sharedTickers: { count: 10, processed: 10 },
    fullUniverseCounts: EOD_PUBLICATION_SCOPES.slice(1).map((scope) => ({ universeId: scope.slice(8) as EodCutoverEvidence["fullUniverseCounts"][number]["universeId"],
      memberCount: 10, attemptedCount: 10, observedCount: 10 })),
    scopes: EOD_PUBLICATION_SCOPES.map((scope) => ({ scope, publicationId: `p-${scope}`, sessionDate: "2026-09-09" })),
    measurements: { usageDate: "2026-09-09", eodRowsRead: 1000, eodRowsWritten: 1000, accountRowsRead: 2000, accountRowsWritten: 2000,
      httpCpuMs: 1, coordinatorCpuMs: 1, queriesPerInvocation: 1, queryDurationMs: 1, source: "collected" },
    limits: { httpCpuMs: 10, coordinatorCpuMs: 10, queriesPerInvocation: 50, queryDurationMs: 30000 },
    capacity: { measuredAt: stamp, marketDatabaseBytes: 1000, priceTableAndIndexBytes: 800, priceRows: 200, retainedPriceRows: 200,
      archiveDatabaseBytes: 100, additionalArchiveBytes: 100 },
    readers: { contractVersion: 1, checkedAt: stamp, consumers: ["overview"], parityPassed: true },
    retention: { hotSessions: 90, sweepHeadroomSessions: 10 } };
  const migration = { id: "market-storage:test", status: "completed", completed_at: "2026-09-09T22:00:00Z",
    source_database_id: source, target_database_id: target, history_database_id: history, code_revision: originalRevision } as StorageMigrationRun;
  return { accountId: "c".repeat(32), workerName: "market-command-worker", codeRevision: currentRevision,
    migrationId: migration.id, marketDatabaseId: target, historyDatabaseId: history, opsDatabaseId: ops,
    trackedConfig: { name: "market-command-worker", vars: { EOD_RUNNER_MODE: "active", EOD_READ_ENABLED: "true", EOD_ARCHIVE_PRUNE_ENABLED: "true" },
      d1_databases: [{ binding: "MARKET_DATA_DB", database_id: target }, { binding: "MARKET_HISTORY_DB", database_id: history }, { binding: "OPS_DB", database_id: ops }] },
    githubMainRevision: currentRevision, githubVariables: new Map(Object.entries({ CLOUDFLARE_ACCOUNT_ID: "c".repeat(32),
      EOD_MARKET_DATABASE_ID: target, EOD_HISTORY_DATABASE_ID: history, EOD_OPS_DATABASE_ID: ops, EOD_STORAGE_SOURCE_DATABASE_ID: source, EOD_RUNNER_MODE: "active",
      EOD_PRODUCTION_CODE_REVISION: currentRevision, EOD_ARCHIVE_PRUNE_ENABLED: "true" })),
    migration, activation: { version: 1, activatedAt: "2026-09-09T21:30:00Z", codeRevision: originalRevision, marketDatabaseId: target },
    codeApproval: { version: 1, codeRevision: currentRevision, methodologyVersion: EOD_METRICS_VERSION, approvedAt: stamp,
      proofHash: await storageHash(proof), proof },
    binding: { version: 1 as const, workerName: "market-command-worker", codeRevision: currentRevision, marketDatabaseId: target,
      historyDatabaseId: history, opsDatabaseId: ops, observedAt: stamp, deploymentId, versionId: workerVersion, archivePruneEnabled: true }, now: new Date("2026-09-10T02:00:30Z") };
}
describe("verified production configuration milestone", () => {
  it("records a later approved SHA while preserving original migration activation identity", async () => {
    const f = await fixture(), record = await validateEodProductionConfiguration(f);
    expect(record).toEqual({ version: 1, codeRevision: currentRevision, activationCodeRevision: originalRevision,
      recordedAt: f.now.toISOString(), marketDatabaseId: target, migrationId: f.migration.id, workerVersion });
  });
  it("also permits the original activation SHA when the canonical config is tracked and approved", async () => {
    const f = await fixture(); f.migration.code_revision = currentRevision; f.activation.codeRevision = currentRevision;
    expect((await validateEodProductionConfiguration(f)).activationCodeRevision).toBe(currentRevision);
  });
  it("does not treat original activation approval as approval for new code", async () => {
    const f = await fixture(); f.codeApproval.codeRevision = originalRevision; f.codeApproval.proof.codeRevision = originalRevision;
    f.codeApproval.proofHash = await storageHash(f.codeApproval.proof);
    await expect(validateEodProductionConfiguration(f)).rejects.toThrow("current-code-approval-required");
    await expect(validateEodProductionConfiguration({ ...f, codeApproval: null })).rejects.toThrow("current-code-approval-required");
  });
  it("rejects a forged approval hash and an activation from a different migration code", async () => {
    const f = await fixture(); f.codeApproval.proofHash = "0".repeat(64);
    await expect(validateEodProductionConfiguration(f)).rejects.toThrow("current-code-approval-required");
    const next = await fixture(); next.activation.codeRevision = currentRevision;
    await expect(validateEodProductionConfiguration(next)).rejects.toThrow("original-activation-mismatch");
  });
  it("rejects unfinished migration and a changed GitHub main", async () => {
    const f = await fixture(); f.migration.status = "awaiting-cutover";
    await expect(validateEodProductionConfiguration(f)).rejects.toThrow("completed-migration-required");
    f.migration.status = "completed"; f.githubMainRevision = originalRevision;
    await expect(validateEodProductionConfiguration(f)).rejects.toThrow("checkout-revision-mismatch");
  });
  it("requires the checked-in canonical target and active public reads", async () => {
    const f = await fixture(); f.trackedConfig.d1_databases[0].database_id = source;
    await expect(validateEodProductionConfiguration(f)).rejects.toThrow("tracked-database-mismatch");
    f.trackedConfig.d1_databases[0].database_id = target; f.trackedConfig.vars.EOD_READ_ENABLED = "false";
    await expect(validateEodProductionConfiguration(f)).rejects.toThrow("tracked-canonical-config-required");
  });
  it("rejects a stale code revision literal retained in the canonical tracked config", async () => {
    const f = await fixture(); Object.assign(f.trackedConfig.vars, { EOD_CODE_REVISION: originalRevision });
    await expect(validateEodProductionConfiguration(f)).rejects.toThrow("tracked-code-revision-conflict");
  });
  it("rejects mismatched GitHub canonical ID, active mode or immutable source", async () => {
    for (const key of ["EOD_MARKET_DATABASE_ID", "EOD_RUNNER_MODE", "EOD_STORAGE_SOURCE_DATABASE_ID"]) {
      const f = await fixture(); f.githubVariables.set(key, "wrong");
      await expect(validateEodProductionConfiguration(f)).rejects.toThrow("github-canonical-config-mismatch");
    }
  });
  it("requires recent actually serving HEAD and exact target/history/Ops identities", async () => {
    for (const field of ["marketDatabaseId", "historyDatabaseId", "opsDatabaseId", "codeRevision"] as const) {
      const f = await fixture(); f.binding[field] = "wrong";
      await expect(validateEodProductionConfiguration(f)).rejects.toThrow("serving-version-mismatch");
    }
    const f = await fixture(); f.now = new Date("2026-09-10T02:05:00Z");
    await expect(validateEodProductionConfiguration(f)).rejects.toThrow("serving-version-mismatch");
  });
  it("returns activation pending only after real serving, approval and canonical configuration checks pass", async () => {
    const f = await fixture(); f.githubVariables.delete("EOD_PRODUCTION_CODE_REVISION"); f.githubVariables.delete("EOD_ARCHIVE_PRUNE_ENABLED");
    await expect(validateEodProductionConfiguration(f)).rejects.toThrow("github-activation-pending");
    f.binding.archivePruneEnabled = false;
    await expect(validateEodProductionConfiguration(f)).rejects.toThrow("serving-version-mismatch");
    f.binding.archivePruneEnabled = true; f.codeApproval.proofHash = "0".repeat(64);
    await expect(validateEodProductionConfiguration(f)).rejects.toThrow("current-code-approval-required");
  });
  it("rejects an unrelated production pin and disabled tracked pruning", async () => {
    const f = await fixture(); f.githubVariables.set("EOD_PRODUCTION_CODE_REVISION", "d".repeat(40));
    await expect(validateEodProductionConfiguration(f)).rejects.toThrow("github-activation-conflict");
    f.githubVariables.set("EOD_PRODUCTION_CODE_REVISION", currentRevision); f.trackedConfig.vars.EOD_ARCHIVE_PRUNE_ENABLED = "false";
    await expect(validateEodProductionConfiguration(f)).rejects.toThrow("tracked-canonical-config-required");
  });
});
describe("configuration persistence on the real Ops schema", () => {
  it("preserves first observation on identical replay and records a later approved deployment", async () => {
    const sqlite = createSqliteD1(); sqlite.migrate("ops-migrations");
    try {
      const original = await validateEodProductionConfiguration(await fixture());
      expect(await storeEodProductionConfiguration(sqlite.db, original)).toEqual(original);
      const later = { ...original, recordedAt: "2026-09-10T02:01:00.000Z" };
      expect(await storeEodProductionConfiguration(sqlite.db, later)).toEqual(original);
      const updated = { ...later, codeRevision: "d".repeat(40), workerVersion: deploymentId };
      expect(await storeEodProductionConfiguration(sqlite.db, updated)).toEqual(updated);
      const saved = await sqlite.db.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?").bind(EOD_CONFIGURATION_KEY).first<string>("evidence_json");
      expect(JSON.parse(saved!)).toEqual(updated);
    } finally { sqlite.dispose(); }
  });
  it("never replaces another activation or a newer verified record", async () => {
    const sqlite = createSqliteD1(); sqlite.migrate("ops-migrations");
    try {
      const record = await validateEodProductionConfiguration(await fixture());
      await storeEodProductionConfiguration(sqlite.db, record);
      await expect(storeEodProductionConfiguration(sqlite.db, { ...record, activationCodeRevision: currentRevision })).rejects.toThrow("previous-activation-conflict");
      await expect(storeEodProductionConfiguration(sqlite.db, { ...record, codeRevision: originalRevision, recordedAt: "2026-09-10T01:59:00.000Z" })).rejects.toThrow("newer-record-exists");
    } finally { sqlite.dispose(); }
  });
});
