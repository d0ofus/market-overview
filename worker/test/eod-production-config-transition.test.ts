import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "smol-toml";
import { validateProductionConfigDelta, deriveProductionConfigProof } from "../src/eod-production-config-transition";
import { assertEodCutover, type EodCutoverEvidence } from "../src/eod-rollout-service";
import { EOD_PUBLICATION_SCOPES } from "../src/eod-coordinator";
import { EOD_METRICS_VERSION } from "../src/eod-metrics";
import { MARKET_HISTORY_REQUIRED_CONSUMERS } from "../src/eod-history-maintenance";
import { eodHash } from "../src/eod-publication-service";
import type { StorageMigrationIdentity } from "../src/market-storage-control";
import type { Env } from "../src/types";

const oldRevision = "a".repeat(40), nextRevision = "b".repeat(40), stamp = "2026-09-10T22:00:00Z", now = new Date("2026-09-10T22:30:00Z");
const identity: StorageMigrationIdentity = { id: "market-storage:2026-09-10:aaaaaaaaaaaa", codeRevision: oldRevision,
  sourceDatabaseId: "00000000-0000-4000-8000-000000000001", targetDatabaseId: "00000000-0000-4000-8000-000000000002",
  historyDatabaseId: "00000000-0000-4000-8000-000000000003", sessionDate: "2026-09-10" };
function configs() {
  const approved = { name: "market-command-worker", main: "src/index.ts", compatibility_date: "2025-01-15",
    vars: { EOD_RUNNER_MODE: "shadow", EOD_READ_ENABLED: "false", EOD_ARCHIVE_PRUNE_ENABLED: "false" },
    triggers: { crons: ["*/5 * * * *"] }, queues: { consumers: [{ queue: "existing" }] },
    d1_databases: [{ binding: "MARKET_DATA_DB", database_id: identity.sourceDatabaseId, database_name: "market_prices", migrations_dir: "market-data-migrations" },
      { binding: "MARKET_HISTORY_DB", database_id: identity.historyDatabaseId, database_name: "history", migrations_dir: "history-migrations" }] };
  const candidate = structuredClone(approved);
  candidate.vars.EOD_RUNNER_MODE = "active"; candidate.vars.EOD_READ_ENABLED = "true";
  candidate.vars.EOD_ARCHIVE_PRUNE_ENABLED = "true";
  candidate.d1_databases[0].database_id = identity.targetDatabaseId; candidate.d1_databases[0].database_name = "market-target";
  return { approved, candidate };
}
const delta = (patch: Partial<Parameters<typeof validateProductionConfigDelta>[0]> = {}) => {
  const { approved, candidate } = configs();
  return validateProductionConfigDelta({ identity, nextRevision, changedFiles: ["worker/wrangler.toml"],
    approvedToml: stringify(approved), candidateToml: stringify(candidate), targetDatabaseName: "market-target", ...patch });
};
function proof(): EodCutoverEvidence {
  return { version: 1, codeRevision: oldRevision, methodologyVersion: EOD_METRICS_VERSION, measuredAt: stamp,
    sessionDate: identity.sessionDate, runId: "eod:active:2026-09-10:daily", sharedTickers: { count: 60, processed: 60 },
    fullUniverseCounts: EOD_PUBLICATION_SCOPES.slice(1).map((scope) => ({ universeId: scope.slice(8) as EodCutoverEvidence["fullUniverseCounts"][number]["universeId"], memberCount: 10, attemptedCount: 10, observedCount: 10 })),
    scopes: EOD_PUBLICATION_SCOPES.map((scope) => ({ scope, publicationId: `p-${scope}`, sessionDate: identity.sessionDate })),
    measurements: { usageDate: identity.sessionDate, eodRowsRead: 1000, eodRowsWritten: 100, accountRowsRead: 2000, accountRowsWritten: 200,
      httpCpuMs: 2, coordinatorCpuMs: 2, queriesPerInvocation: 10, queryDurationMs: 20, source: "actual accepted measurements" },
    limits: { httpCpuMs: 10, coordinatorCpuMs: 10, queriesPerInvocation: 50, queryDurationMs: 30000 },
    capacity: { measuredAt: stamp, marketDatabaseBytes: 50_000_000, priceTableAndIndexBytes: 40_000_000, priceRows: 60 * 270,
      retainedPriceRows: 60 * 270, archiveDatabaseBytes: 20_000_000, additionalArchiveBytes: 10_000_000 },
    readers: { contractVersion: 1, checkedAt: stamp, consumers: [...MARKET_HISTORY_REQUIRED_CONSUMERS], parityPassed: true },
    retention: { hotSessions: 260, sweepHeadroomSessions: 10 } };
}
const derive = (patch: Partial<Parameters<typeof deriveProductionConfigProof>[0]> = {}) => deriveProductionConfigProof({
  sourceProof: proof(), identity, nextRevision, expectedSession: identity.sessionDate, targetBytes: 10_000_000, historyBytes: 20_000_000, now, ...patch });
afterEach(() => vi.useRealTimers());

describe("narrow canonical production configuration transition", () => {
  it("accepts only the source-to-target binding and active read/write settings while preserving measured dates", async () => {
    expect(await delta()).toMatchObject({ approvedConfigHash: expect.stringMatching(/^[a-f0-9]{64}$/), candidateConfigHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const next = derive();
    expect(next).toEqual({ ...proof(), codeRevision: nextRevision });
    expect(next.measuredAt).toBe(stamp); expect(next.capacity.measuredAt).toBe(stamp);
    expect(await eodHash(next)).not.toBe(await eodHash(proof()));
  });
  it("allows the original migration identifier and formatting changes but no arbitrary release metadata", async () => {
    const { candidate } = configs();
    await expect(delta({ candidateToml: stringify({ ...candidate, vars: { ...candidate.vars, EOD_STORAGE_MIGRATION_ID: identity.id } }) + "\n# reviewed target configuration\n" })).resolves.toBeDefined();
    await expect(delta({ candidateToml: stringify({ ...candidate, vars: { ...candidate.vars, RELEASE_NOTES: "extra" } }) })).rejects.toThrow("unapproved-runtime-config-change");
  });
  it.each([[], ["worker/wrangler.toml", "worker/src/index.ts"], ["worker/wrangler.toml", "package-lock.json"], ["worker/src/index.ts"]].map((changedFiles) => ({ changedFiles })))(
    "rejects application, dependency or missing configuration changes $changedFiles", async ({ changedFiles }) => {
      await expect(delta({ changedFiles })).rejects.toThrow("configuration-only-commit-required");
    },
  );
  it.each(["cron", "queue", "history", "prune", "compatibility", "revision"])("rejects unexpected runtime configuration change %s", async (kind) => {
    const { candidate } = configs();
    if (kind === "cron") candidate.triggers.crons = ["* * * * *"];
    if (kind === "queue") candidate.queues.consumers[0].queue = "other";
    if (kind === "history") candidate.d1_databases[1].database_id = identity.sourceDatabaseId;
    if (kind === "prune") candidate.vars.EOD_ARCHIVE_PRUNE_ENABLED = "false";
    if (kind === "compatibility") candidate.compatibility_date = "2026-09-10";
    const candidateToml = stringify(kind === "revision" ? { ...candidate, vars: { ...candidate.vars, EOD_CODE_REVISION: oldRevision } } : candidate);
    await expect(delta({ candidateToml })).rejects.toThrow(/config/);
  });
  it("allows live bookkeeping growth inside the measured projection, while rejecting exhausted headroom", () => {
    expect(derive({ targetBytes: 10_000_000 + 4096, historyBytes: 20_000_000 + 4096 }).codeRevision).toBe(nextRevision);
    expect(() => derive({ targetBytes: 50_000_001 })).toThrow("current-capacity-exceeds-evidence");
    expect(() => derive({ historyBytes: 30_000_001 })).toThrow("current-capacity-exceeds-evidence");
    expect(() => derive({ targetBytes: 350_000_000 })).toThrow("current-capacity-exceeds-evidence");
  });
  it("rejects expired or later-session evidence without refreshing old measurement timestamps", () => {
    expect(() => derive({ now: new Date("2026-09-12T00:00:00Z") })).toThrow("measurement-expired");
    expect(() => derive({ expectedSession: "2026-09-11" })).toThrow("current-session-proof-required");
  });
  it("runs existing live acceptance checks for a supplied proof, including an already-approved replay", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const next = derive(), approval = { version: 1, codeRevision: nextRevision, methodologyVersion: EOD_METRICS_VERSION,
      approvedAt: stamp, proofHash: await eodHash(next), proof: next };
    for (const existing of [null, approval]) {
      const writes = vi.fn();
      const db = { prepare: (sql: string) => {
        const statement = { bind: () => statement, first: async () => {
          if (sql.includes("WHERE id='cutover'")) throw new Error("must not rewrite or read unrelated global cutover evidence");
          if (sql.includes("FROM eod_rollout_evidence")) return existing ? { evidence_json: JSON.stringify(existing) } : null;
          if (sql.includes("FROM eod_runs")) return null;
          throw new Error("unexpected query");
        }, run: writes };
        return statement;
      } } as unknown as D1Database;
      await expect(assertEodCutover({ EOD_RUNNER_MODE: "active", OPS_DB: db, MARKET_DATA_DB: db, MARKET_HISTORY_DB: db } as Env,
        nextRevision, next)).rejects.toThrow("completed-run-required");
      expect(writes).not.toHaveBeenCalled();
    }
  });
});
