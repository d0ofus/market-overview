import { describe, expect, it, vi } from "vitest";
import { startStorageMigrationOnce, type StorageStartDependencies, type StorageStartInput } from "../src/market-storage-start";
import type { StorageMigrationRun } from "../src/market-storage-control";
import { storageHash } from "../src/market-storage-pages";

const source = "10000000-0000-4000-8000-000000000001", history = "10000000-0000-4000-8000-000000000002";
const ops = "10000000-0000-4000-8000-000000000003", target = "10000000-0000-4000-8000-000000000004";
const schemaHash = "c".repeat(64), codeRevision = "a".repeat(40), sessionDate = "2026-09-08";
async function setup() {
  const tickers = ["AAA", "BBB"];
  const analysis = { version: 1, measuredAt: "2026-09-09T00:00:00Z", sessionDate,
    source: { snapshotSha256: "b".repeat(64), schemaSha256: schemaHash,
      capture: { kind: "logical-d1-capacity-snapshot", completeDeclared: true, partialEstimate: false } },
    population: { count: tickers.length, sha256: await storageHash(tickers) },
    archive: { sourceRows: 6000, storageRoundTripPassed: true, withAdditionalCompleteRevisionAndTransientBytes: 100_000_000 },
    bootstrap: { recentRowsToInsert: 2, nonPriceRowsPreserved: true, database: { physicalBytes: 10_000_000 } },
    retentionModels: [260, 90].map((hotSessions) => ({ hotSessions, sweepHeadroomSessions: 10, sharedTickers: 2,
      modeledSipRows: 2 * (hotSessions + 10), fallbackTickerReserve: 2, modeledFallbackRows: 2 * (hotSessions + 10),
      database: { physicalBytes: 20_000_000 }, publicationGrowthReserveBytes: 0, projectedBytes: 20_000_000, under350MB: true })),
  };
  const input: StorageStartInput = { accountId: "b".repeat(32), sourceDatabaseId: source, historyDatabaseId: history, opsDatabaseId: ops,
    migrationId: `market-storage:${sessionDate}:${codeRevision.slice(0, 12)}`, targetName: "market-prices-eod-2026-09-08-aaaaaaaaaaaa",
    codeRevision, sessionDate, tickers, analysis, snapshotSource: { accountId: "b".repeat(32), sourceDatabaseId: source,
      runId: `eod:shadow:${sessionDate}:daily` }, now: new Date("2026-09-09T01:00:00Z") };
  const events: string[] = [];
  let stored: StorageMigrationRun | null = null;
  const deps: StorageStartDependencies = {
    assertCheckout: vi.fn(async () => { events.push("checkout"); }),
    inspectSource: vi.fn(async () => { events.push("inspect-source"); return { schemaHash, coordinatorMigrationId: null }; }),
    listDatabases: vi.fn(async () => [source, history, ops].map((id, index) => ({ id, name: `existing-${index}`, bytes: 50_000_000 }))),
    verifyGitHub: vi.fn(async () => ({ targetDatabaseId: null, codeRevision: null })),
    createDatabase: vi.fn(async (name) => { events.push("create-database"); return { id: target, name, bytes: 8192 }; }),
    loadRun: vi.fn(async () => stored),
    assertEmptyTarget: vi.fn(async () => { events.push("empty-target"); }),
    createRun: vi.fn(async (identity) => { events.push("create-run"); stored = { id: identity.id, source_database_id: source,
      target_database_id: target, history_database_id: history, session_date: sessionDate, code_revision: codeRevision,
      freeze_authorized: 0, status: "queued", source_schema_hash: null } as StorageMigrationRun; }),
    initializeHistory: vi.fn(async () => { events.push("history"); }),
    authorizeRun: vi.fn(async () => { events.push("authorize"); stored!.freeze_authorized = 1; stored!.source_schema_hash = schemaHash; }),
    configureGitHub: vi.fn(async () => { events.push("github-target-source-pin"); }),
    deployCoordinator: vi.fn(async () => { events.push("deploy-coordinator"); }),
    verifyCoordinator: vi.fn(async () => { events.push("verify-coordinator"); }),
    dispatch: vi.fn(async () => { events.push("dispatch"); }),
    journal: vi.fn(async () => undefined),
  };
  return { input, analysis, deps, events, setRun: (value: StorageMigrationRun | null) => { stored = value; } };
}

describe("reviewed one-time storage start ordering", () => {
  it("validates complete capacity, persists Ops ownership and authorizes before enabling dispatch", async () => {
    const { input, deps, events } = await setup();
    expect(await startStorageMigrationOnce(input, deps)).toMatchObject({ status: "dispatch-accepted", publicCutover: false,
      identity: { sourceDatabaseId: source, targetDatabaseId: target } });
    expect(events.filter((event) => event !== "checkout")).toEqual(["inspect-source", "create-database", "empty-target", "create-run",
      "history", "authorize", "github-target-source-pin", "deploy-coordinator", "verify-coordinator", "dispatch"]);
    expect(deps.configureGitHub).toHaveBeenCalledWith(source, target, codeRevision);
  });
  it("rejects partial capacity evidence before provisioning any database", async () => {
    const { input, analysis, deps } = await setup(); analysis.source.capture.completeDeclared = false;
    await expect(startStorageMigrationOnce(input, deps)).rejects.toThrow("complete-analysis-required");
    expect(deps.createDatabase).not.toHaveBeenCalled(); expect(deps.createRun).not.toHaveBeenCalled();
  });
  it("rejects the measured 90-session layout that fits physically but lacks publication headroom", async () => {
    const { input, analysis, deps } = await setup();
    // September 10 production sizing: preserving the shared population and
    // legacy tables leaves only 27,075,456 bytes before publication reserves.
    input.tickers = Array.from({ length: 5921 }, (_, index) => `T${String(index).padStart(5, "0")}`);
    analysis.population = { count: input.tickers.length, sha256: await storageHash(input.tickers) };
    analysis.archive.sourceRows = 1_989_616;
    analysis.archive.withAdditionalCompleteRevisionAndTransientBytes = 207_986_688;
    analysis.bootstrap.database.physicalBytes = 115_458_048;
    for (const model of analysis.retentionModels) {
      model.sharedTickers = input.tickers.length; model.fallbackTickerReserve = input.tickers.length;
      model.modeledSipRows = input.tickers.length * (model.hotSessions + model.sweepHeadroomSessions);
      model.modeledFallbackRows = model.modeledSipRows;
      model.database.physicalBytes = model.hotSessions === 90 ? 322_924_544 : 673_886_208;
      model.projectedBytes = model.database.physicalBytes;
      model.under350MB = model.projectedBytes < 350_000_000;
    }
    expect(analysis.retentionModels.find((model) => model.hotSessions === 90)?.under350MB).toBe(true);
    await expect(startStorageMigrationOnce(input, deps)).rejects.toThrow("storage-preflight-insufficient-headroom");
    expect(deps.createDatabase).not.toHaveBeenCalled(); expect(deps.createRun).not.toHaveBeenCalled();
    expect(deps.authorizeRun).not.toHaveBeenCalled(); expect(deps.configureGitHub).not.toHaveBeenCalled();
    expect(deps.deployCoordinator).not.toHaveBeenCalled(); expect(deps.dispatch).not.toHaveBeenCalled();
  });
  it("does not create a target when a full free database inventory leaves no slot", async () => {
    const { input, deps } = await setup();
    const existing = await deps.listDatabases();
    vi.mocked(deps.listDatabases).mockResolvedValue([...existing, ...Array.from({ length: 7 }, (_, index) => ({
      id: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`, name: `other-${index}`, bytes: 20_000_000,
    }))]);
    await expect(startStorageMigrationOnce(input, deps)).rejects.toThrow("free-account-capacity-exceeded");
    expect(deps.createDatabase).not.toHaveBeenCalled();
  });
  it("includes the existing source and both projected destinations in the five-GB account headroom", async () => {
    const { input, deps } = await setup();
    vi.mocked(deps.listDatabases).mockResolvedValue((await deps.listDatabases()).map((row) => ({ ...row, bytes: 2_450_000_000 })));
    await expect(startStorageMigrationOnce(input, deps)).rejects.toThrow("free-account-capacity-exceeded");
    expect(deps.createDatabase).not.toHaveBeenCalled();
  });
  it("reuses only an empty deterministic target rather than provisioning a second database", async () => {
    const { input, deps } = await setup();
    vi.mocked(deps.listDatabases).mockResolvedValue([...(await deps.listDatabases()), { id: target, name: input.targetName, bytes: 8192 }]);
    await startStorageMigrationOnce(input, deps);
    expect(deps.createDatabase).not.toHaveBeenCalled(); expect(deps.assertEmptyTarget).toHaveBeenCalledWith(target);
  });
  it("never overwrites a reused nonempty database", async () => {
    const { input, deps } = await setup();
    vi.mocked(deps.assertEmptyTarget).mockRejectedValue(new Error("storage-start-existing-target-not-empty"));
    await expect(startStorageMigrationOnce(input, deps)).rejects.toThrow("target-not-empty");
    expect(deps.createRun).not.toHaveBeenCalled(); expect(deps.initializeHistory).not.toHaveBeenCalled();
  });
  it("stops quota exhaustion during read-only preflight before any provisioning", async () => {
    const { input, deps } = await setup();
    vi.mocked(deps.inspectSource).mockRejectedValue(new Error("eod-d1-budget-exhausted"));
    await expect(startStorageMigrationOnce(input, deps)).rejects.toThrow("budget-exhausted");
    expect(deps.createDatabase).not.toHaveBeenCalled();
  });
  it("stops after persisted creation if history initialization exhausts quota; it does not authorize or deploy", async () => {
    const { input, deps } = await setup();
    vi.mocked(deps.initializeHistory).mockRejectedValue(new Error("eod-d1-budget-exhausted"));
    await expect(startStorageMigrationOnce(input, deps)).rejects.toThrow("budget-exhausted");
    expect((await deps.loadRun(input.migrationId))?.target_database_id).toBe(target);
    expect(deps.authorizeRun).not.toHaveBeenCalled(); expect(deps.deployCoordinator).not.toHaveBeenCalled();
  });
  it("checks changed checkout again before provisioning", async () => {
    const { input, deps } = await setup();
    vi.mocked(deps.assertCheckout).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("storage-start-checkout-changed"));
    await expect(startStorageMigrationOnce(input, deps)).rejects.toThrow("checkout-changed");
    expect(deps.createDatabase).not.toHaveBeenCalled();
  });
  it("never deploys when authorization did not durably persist", async () => {
    const { input, deps } = await setup(); vi.mocked(deps.authorizeRun).mockResolvedValue(undefined);
    await expect(startStorageMigrationOnce(input, deps)).rejects.toThrow("authorization-not-persisted");
    expect(deps.configureGitHub).not.toHaveBeenCalled(); expect(deps.dispatch).not.toHaveBeenCalled();
  });
  it("does not dispatch if the deployed coordinator cannot be independently verified", async () => {
    const { input, deps } = await setup(); vi.mocked(deps.verifyCoordinator).mockRejectedValue(new Error("worker-wrong-binding"));
    await expect(startStorageMigrationOnce(input, deps)).rejects.toThrow("worker-wrong-binding"); expect(deps.dispatch).not.toHaveBeenCalled();
  });
  it("rejects a conflicting durable run before provisioning", async () => {
    const { input, deps, setRun } = await setup(); setRun({ target_database_id: target, code_revision: "z".repeat(40) } as StorageMigrationRun);
    await expect(startStorageMigrationOnce(input, deps)).rejects.toThrow("durable-run-conflict"); expect(deps.createDatabase).not.toHaveBeenCalled();
  });
  it("does not overwrite another migration's GitHub pin or coordinator", async () => {
    const { input, deps } = await setup(); vi.mocked(deps.verifyGitHub).mockResolvedValue({ targetDatabaseId: null, codeRevision: "d".repeat(40) });
    await expect(startStorageMigrationOnce(input, deps)).rejects.toThrow("github-revision-conflict");
    vi.mocked(deps.inspectSource).mockResolvedValue({ schemaHash, coordinatorMigrationId: "market-storage:other" });
    await expect(startStorageMigrationOnce(input, deps)).rejects.toThrow("another-coordinator-active"); expect(deps.createDatabase).not.toHaveBeenCalled();
  });
  it("does not let a failed local diagnostic journal replace or prevent durable Ops ownership", async () => {
    const { input, deps } = await setup(); vi.mocked(deps.journal).mockRejectedValue(new Error("local-disk-full"));
    expect((await startStorageMigrationOnce(input, deps)).status).toBe("dispatch-accepted");
    expect((await deps.loadRun(input.migrationId))?.freeze_authorized).toBe(1);
  });
});
