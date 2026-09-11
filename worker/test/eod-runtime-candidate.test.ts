import { describe, expect, it, vi } from "vitest";
import { parse } from "smol-toml";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { assertCandidateMigrationState, privateRuntimeAdminSecret, assertRuntimeCandidateCredentialBinding, prepareRuntimeCandidateConfig, runCandidateProbes, runtimeCandidateIdentity,
  runtimeCandidatePublicationHash, runtimeCandidateEvidenceFilename, runtimeCollectorOptions, runtimeCollectorCacheMatches,
  assertRuntimeCandidateWindow, runtimeCandidateRequiresWindow, type CandidateProbeState } from "../src/eod-runtime-candidate";
import { authorizeStorageMigrationFreeze, claimStorageMigration, createStorageMigration, loadStorageMigration,
  pauseStorageMigration, progressStorageMigration, recordStorageSourceCapture, resumeStorageMigration,
  type StorageMigrationIdentity, type StorageMigrationRun } from "../src/market-storage-control";
import { createSqliteD1 } from "./helpers/sqlite-d1";
import type { StoragePublicationEvidence } from "../src/market-storage-acceptance";
import { resolveEodBudgetProfile } from "../src/eod-budget-profile";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const migration: StorageMigrationIdentity = { id: "market-storage:test", sourceDatabaseId: uuid(1), targetDatabaseId: uuid(2), historyDatabaseId: uuid(3), sessionDate: "2026-09-10", codeRevision: "a".repeat(40) };
const identity = () => runtimeCandidateIdentity({ migration, sessionDate: "2026-09-10", opsDatabaseId: uuid(4), coreDatabaseId: uuid(5) });
const now = new Date("2026-09-10T21:00:00Z"), probeUntil = "2026-09-10T23:00:00Z";
function reviewed() {
  return { name: "production", main: "src/index.ts", compatibility_date: "2025-01-15", vars: { EOD_STORAGE_MIGRATION_ID: migration.id, ALPACA_DAILY_FEED: "sip" },
    d1_databases: Object.entries({ DB: uuid(5), MARKET_DATA_DB: uuid(1), MARKET_HISTORY_DB: uuid(3), OPS_DB: uuid(4) })
      .map(([binding, database_id]) => ({ binding, database_id, database_name: "old", migrations_dir: "migrations" })),
    queues: { consumers: [{ queue: "live" }] }, triggers: { crons: ["* * * * *"] }, routes: ["live.example/*"], send_email: [{ name: "MAIL" }] };
}
describe("protected runtime candidate configuration", () => {
  it("rechecks a paused local status after an explicit attempt change while keeping same-attempt caching and child defaults consistent", () => {
    const codeRevision = "a".repeat(40), first = runtimeCollectorOptions({ runtimeCollectionMode: "live-tail" });
    const previous = { status: "paused", codeRevision, ...first };
    expect(runtimeCollectorCacheMatches(previous, codeRevision, first)).toBe(true);
    const second = runtimeCollectorOptions({ runtimeAttempt: 2 }, { EOD_RUNTIME_COLLECTION_MODE: "live-tail", EOD_RUNTIME_ATTEMPT: "1" });
    expect(runtimeCollectorCacheMatches(previous, codeRevision, second)).toBe(false);
    expect(runtimeCandidateEvidenceFilename(second.runtimeAttempt)).toBe("runtime-evidence-attempt-2.json");
    expect(runtimeCollectorOptions({})).toEqual({ runtimeCollectionMode: "telemetry", runtimeAttempt: 1 });
    expect(runtimeCollectorCacheMatches({ codeRevision }, codeRevision, runtimeCollectorOptions({}))).toBe(true);
    expect(runtimeCollectorCacheMatches({ codeRevision }, codeRevision, first)).toBe(false);
    expect(() => runtimeCollectorOptions({}, { EOD_RUNTIME_ATTEMPT: "5" })).toThrow("attempt-invalid");
    expect(() => runtimeCollectorOptions({}, { EOD_RUNTIME_COLLECTION_MODE: "unknown" })).toThrow("mode-invalid");
  });
  it("preserves an earlier complete artifact when the same publication uses a new bounded attempt", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "runtime-artifact-attempt-"));
    try {
      const first = await identity(), second = await runtimeCandidateIdentity({ migration, sessionDate: "2026-09-10",
        opsDatabaseId: uuid(4), coreDatabaseId: uuid(5), attempt: 2 });
      const old = { complete: true, identity: first, publicationHash: "b".repeat(64), collectedAt: "2026-09-10T21:00:00.000Z" };
      writeFileSync(resolve(directory, runtimeCandidateEvidenceFilename(1)), JSON.stringify(old), { flag: "wx" });
      writeFileSync(resolve(directory, runtimeCandidateEvidenceFilename(2)), JSON.stringify({ ...old, identity: second }), { flag: "wx" });
      expect(JSON.parse(readFileSync(resolve(directory, runtimeCandidateEvidenceFilename(1)), "utf8"))).toEqual(old);
      expect(JSON.parse(readFileSync(resolve(directory, runtimeCandidateEvidenceFilename(2)), "utf8")).identity.probeId).toBe(second.probeId);
      expect(second.probeId).not.toBe(first.probeId);
      for (const invalid of [0, 5, 1.5, NaN]) expect(() => runtimeCandidateEvidenceFilename(invalid)).toThrow("attempt-invalid");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("preserves the paid profile and rejects measurements under a different profile", async () => {
    const paidIdentity=await runtimeCandidateIdentity({migration,sessionDate:migration.sessionDate,
      opsDatabaseId:uuid(4),coreDatabaseId:uuid(5),budgetProfile:"paid"});
    const config=reviewed(), paid={...config,vars:{...config.vars,EOD_BUDGET_PROFILE:"paid"}};
    const options={mainPath:"/repo/worker/src/index.ts",probeUntil,now};
    expect(prepareRuntimeCandidateConfig(paid,paidIdentity,options).vars.EOD_BUDGET_PROFILE).toBe("paid");
    expect(()=>prepareRuntimeCandidateConfig(config,paidIdentity,options)).toThrow("budget-profile-mismatch");
    expect(()=>prepareRuntimeCandidateConfig(paid,{...paidIdentity,budgetProfile:"free"},options)).toThrow("budget-profile-mismatch");
  });
  it("measures actual overnight recovery after close without a new opening window", () => {
    const session = { sessionDate: "2026-09-10", closeAt: "16:00" };
    for (const stamp of ["2026-09-10T05:00:00Z", "2026-09-10T13:05:00Z", "2026-09-10T16:00:00Z", "2026-09-10T20:19:00Z"]) {
      expect(() => assertRuntimeCandidateWindow(new Date(stamp), session)).toThrow("await-actual-coordinator-window");
    }
    for (const stamp of ["2026-09-10T20:20:00Z", "2026-09-11T00:05:00Z", "2026-09-11T05:00:00Z", "2026-09-12T20:30:00Z"]) {
      expect(() => assertRuntimeCandidateWindow(new Date(stamp), session)).not.toThrow();
    }
    expect(() => assertRuntimeCandidateWindow(new Date("2026-09-12T20:30:00Z"), null)).toThrow("await-actual-coordinator-window");
    expect(() => assertRuntimeCandidateWindow(new Date("2026-11-27T18:20:00Z"), { sessionDate: "2026-11-27", closeAt: "13:00" })).not.toThrow();
    expect(runtimeCandidateRequiresWindow("run")).toBe(true);
    expect(runtimeCandidateRequiresWindow("prepare")).toBe(true);
    expect(runtimeCandidateRequiresWindow("collect")).toBe(false);
    const complete = { from: now.getTime(), to: now.getTime(), probes: Array.from({ length: 5 }, () => ({ route: "/api/dashboard", status: "ok" as const, startedAt: now.toISOString() })) };
    expect(runtimeCandidateRequiresWindow("run", { secretsInstalled: true, samples: complete })).toBe(false);
    expect(runtimeCandidateRequiresWindow("run", { secretsInstalled: true, samples: { ...complete, probes: complete.probes.slice(0, 2) } })).toBe(true);
    expect(runtimeCandidateRequiresWindow("run", { secretsInstalled: true, samples: { ...complete, probes: [{ ...complete.probes[0], status: "started" }] } })).toBe(false);
    expect(runtimeCandidateRequiresWindow("run", { secretsInstalled: false, samples: complete })).toBe(true);
  });
  it("binds same-session corrections while allowing verification timestamps to advance", async () => {
    const publication = { runId: "run", sessionDate: migration.sessionDate, inputClock: 10, tickerHash: "tickers",
      scopes: [{ scope: "overview", id: "publication-1", checksum: "one", revision: 1 }], membershipHash: "members", catalogHash: "catalog",
      checkedAt: now.toISOString() } as StoragePublicationEvidence;
    const original = await runtimeCandidatePublicationHash(publication);
    expect(await runtimeCandidatePublicationHash({ ...publication, checkedAt: probeUntil })).toBe(original);
    expect(await runtimeCandidatePublicationHash({ ...publication, inputClock: 11 })).not.toBe(original);
    expect(await runtimeCandidatePublicationHash({ ...publication, scopes: [{ ...publication.scopes[0], checksum: "corrected", revision: 2 }] })).not.toBe(original);
  });
  it("generates reproducible bounded identities with separate names per session and attempt", async () => {
    expect(await identity()).toEqual(await identity());
    expect((await runtimeCandidateIdentity({ migration, sessionDate: "2026-09-11", opsDatabaseId: uuid(4), coreDatabaseId: uuid(5) })).workerName).not.toBe((await identity()).workerName);
    for (const attempt of [0, 5, 1.5]) await expect(runtimeCandidateIdentity({ migration, sessionDate: migration.sessionDate, opsDatabaseId: uuid(4), coreDatabaseId: uuid(5), attempt })).rejects.toThrow("identity-invalid");
  });
  it("removes production ingress and storage no-op gate while preserving actual runtime settings", async () => {
    const config = prepareRuntimeCandidateConfig(reviewed(), await identity(), { mainPath: "/repo/worker/src/index.ts", probeUntil, now });
    expect(config.vars).toMatchObject({ ALPACA_DAILY_FEED: "sip", EOD_RUNNER_MODE: "active", EOD_READ_ENABLED: "true", EOD_RUNTIME_CANDIDATE_ONLY: "true", ADMIN_AUTH_FAIL_CLOSED: "true" });
    for (const name of ["queues", "triggers", "routes", "send_email"]) expect(config).not.toHaveProperty(name);
    expect(config.vars).not.toHaveProperty("EOD_STORAGE_MIGRATION_ID");
    expect(config.d1_databases.find((row) => row.binding === "MARKET_DATA_DB")?.database_id).toBe(uuid(2));
    expect(config.d1_databases.every((row) => !Object.hasOwn(row, "migrations_dir"))).toBe(true);
    expect(config.observability).toMatchObject({ enabled: true, head_sampling_rate: 1, logs: { invocation_logs: true } });
    expect(config.version_metadata).toEqual({ binding: "EOD_VERSION_METADATA" });
  });
  it("requires exact source/history/core/Ops identities, rejects ambiguous or newly introduced capabilities", async () => {
    const id = await identity(), options = { mainPath: "/repo/worker/src/index.ts", probeUntil, now };
    for (const name of ["DB", "MARKET_DATA_DB", "MARKET_HISTORY_DB", "OPS_DB"]) {
      const changed = reviewed(); changed.d1_databases.find((row) => row.binding === name)!.database_id = uuid(99);
      expect(() => prepareRuntimeCandidateConfig(changed, id, options)).toThrow("binding-mismatch");
    }
    const duplicate = reviewed(); duplicate.d1_databases.push(duplicate.d1_databases[0]);
    expect(() => prepareRuntimeCandidateConfig(duplicate, id, options)).toThrow("binding-invalid");
    expect(() => prepareRuntimeCandidateConfig({ ...reviewed(), services: [{ binding: "LIVE" }] }, id, options)).toThrow("unreviewed-config");
    expect(() => prepareRuntimeCandidateConfig({ ...reviewed(), vars: { ADMIN_SECRET: "must-not-copy" } }, id, options)).toThrow("plaintext-secrets");
  });
  it("accepts the actual reviewed repository TOML without inheriting scheduled or queue events", async () => {
    const input = parse(readFileSync(resolve(process.cwd(), "wrangler.toml"), "utf8"));
    const bindings = input.d1_databases as Array<{ binding: string; database_id: string }>;
    const read = (name: string) => bindings.find((row) => row.binding === name)!.database_id;
    const id = await runtimeCandidateIdentity({ migration: { ...migration, sourceDatabaseId: read("MARKET_DATA_DB"), historyDatabaseId: read("MARKET_HISTORY_DB") },
      sessionDate: migration.sessionDate, opsDatabaseId: read("OPS_DB"), coreDatabaseId: read("DB"),
      budgetProfile:resolveEodBudgetProfile((input.vars as Record<string,string>).EOD_BUDGET_PROFILE).name });
    expect(prepareRuntimeCandidateConfig(input, id, { mainPath: "/repo/worker/src/index.ts", probeUntil, now }).name).toBe(id.workerName);
  });
  it("derives a private replayable credential without a production admin secret or local secret file", async () => {
    const token = "control-token-fixture-".repeat(3), account = "a".repeat(32), id = await identity();
    const secret = await privateRuntimeAdminSecret(token, account, id);
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
    expect(secret).not.toBe(token);
    expect(secret).toBe(await privateRuntimeAdminSecret(token, account, structuredClone(id)));
    expect(secret).not.toBe(await privateRuntimeAdminSecret(token, "b".repeat(32), id));
    expect(secret).not.toBe(await privateRuntimeAdminSecret("rotated-token-fixture-".repeat(3), account, id));
    const next = await runtimeCandidateIdentity({ migration, sessionDate: migration.sessionDate, opsDatabaseId: uuid(4), coreDatabaseId: uuid(5), attempt: 2 });
    expect(secret).not.toBe(await privateRuntimeAdminSecret(token, account, next));
    expect(secret).not.toBe(await privateRuntimeAdminSecret(token, account, { ...id, targetDatabaseId: uuid(99) }));
    await expect(privateRuntimeAdminSecret(token, account, { ...id, workerName: "production" })).rejects.toThrow("private-credential-input-invalid");
    await expect(privateRuntimeAdminSecret("", account, id)).rejects.toThrow("private-credential-input-invalid");
  });
  it("preserves a matching installed credential on replay and rejects changed or unknown installed credentials", () => {
    const fingerprint = "a".repeat(64);
    expect(() => assertRuntimeCandidateCredentialBinding(fingerprint, {})).not.toThrow();
    expect(() => assertRuntimeCandidateCredentialBinding(fingerprint, { candidateCredentialHash: fingerprint, secretsInstalled: true })).not.toThrow();
    for (const state of [{ candidateCredentialHash: "b".repeat(64) }, { secretsInstalled: true }]) {
      expect(() => assertRuntimeCandidateCredentialBinding(fingerprint, state)).toThrow("private-credential-changed-new-attempt-required");
    }
  });
  it("requires final private bootstrap state and refuses active, failed, leased or mismatched migrations", () => {
    const run = { id: migration.id, source_database_id: uuid(1), target_database_id: uuid(2), history_database_id: uuid(3), session_date: migration.sessionDate,
      code_revision: migration.codeRevision, status: "awaiting-evidence", stage: "bootstrap", error_code: "storage-final-acceptance-required", freeze_authorized: 1,
      source_schema_hash: "b".repeat(64), source_revision: 1, lease_until: null } as StorageMigrationRun;
    expect(() => assertCandidateMigrationState(run, migration, now)).not.toThrow();
    for (const patch of [{ status: "running" }, { stage: "storage-final-acceptance-required" }, { error_code: null },
      { error_code: "storage-bootstrap-incomplete" }, { error_code: "storage-population-expansion-required" },
      { freeze_authorized: 0 }, { lease_until: probeUntil }, { target_database_id: uuid(99) }]) {
      expect(() => assertCandidateMigrationState({ ...run, ...patch } as StorageMigrationRun, migration, now)).toThrow("not-ready");
    }
  });
  it("accepts the actual persisted bootstrap pause and rejects a different pause without rewriting its stage", async () => {
    const ops = createSqliteD1();
    try {
      ops.migrate("ops-migrations");
      await createStorageMigration(ops.db, migration, now);
      await authorizeStorageMigrationFreeze(ops.db, migration.id, { sourceDatabaseId: migration.sourceDatabaseId,
        codeRevision: migration.codeRevision, schemaHash: "b".repeat(64), evidenceHash: "c".repeat(64) }, now);
      let owner = (await claimStorageMigration(ops.db, migration.id, { now }))!;
      await recordStorageSourceCapture(ops.db, migration.id, owner.leaseToken, { schemaHash: "b".repeat(64), revision: 1 }, now);
      await progressStorageMigration(ops.db, migration.id, owner.leaseToken, "bootstrap", { sessionDate: migration.sessionDate }, now);
      expect(() => assertCandidateMigrationState(owner.run, migration, now)).toThrow("not-ready");
      await pauseStorageMigration(ops.db, migration.id, owner.leaseToken, "storage-population-expansion-required", {}, now);
      const wrong = (await loadStorageMigration(ops.db, migration.id))!;
      expect(wrong).toMatchObject({ status: "awaiting-evidence", stage: "bootstrap", error_code: "storage-population-expansion-required" });
      expect(() => assertCandidateMigrationState(wrong, migration, now)).toThrow("not-ready");
      await resumeStorageMigration(ops.db, migration.id, migration.codeRevision, now);
      owner = (await claimStorageMigration(ops.db, migration.id, { now }))!;
      // These are the same two control calls used by the real pipeline after
      // it verifies the completed owner and records bootstrap:complete.
      await progressStorageMigration(ops.db, migration.id, owner.leaseToken, "bootstrap", { sessionDate: migration.sessionDate }, now);
      await pauseStorageMigration(ops.db, migration.id, owner.leaseToken, "storage-final-acceptance-required", {}, now);
      const ready = (await loadStorageMigration(ops.db, migration.id))!;
      expect(ready).toMatchObject({ status: "awaiting-evidence", stage: "bootstrap", error_code: "storage-final-acceptance-required",
        lease_token: null, lease_until: null, next_attempt_at: null });
      expect(() => assertCandidateMigrationState(ready, migration, now)).not.toThrow();
      expect(await loadStorageMigration(ops.db, migration.id)).toEqual(ready);
    } finally { ops.dispose(); }
  }, 30_000);
});

describe("candidate HTTP protocol", () => {
  async function fixture() {
    const id = await identity(), states: CandidateProbeState[] = [], eligibility = vi.fn(async () => undefined), version = vi.fn(async () => undefined);
    const fetcher = vi.fn(async () => Response.json({ ok: true }));
    return { identity: id, baseUrl: `https://${id.workerName}.unit.workers.dev`, adminSecret: await privateRuntimeAdminSecret("control-token-fixture-".repeat(3), "a".repeat(32), id),
      state: { from: now.getTime(), to: null, probes: [] } as CandidateProbeState, save: async (value: CandidateProbeState) => { states.push(structuredClone(value)); },
      assertEligible: eligibility, assertCurrentVersion: version, fetcher, states, now: () => now };
  }
  it("claims each exact sample before HTTP, uses auth headers only, and validates before/after", async () => {
    const options = await fixture();
    options.fetcher.mockImplementation(async () => { expect(options.states.at(-1)?.probes.at(-1)?.status).toBe("started"); return Response.json({ ok: true }); });
    const result = await runCandidateProbes(options);
    expect(result.probes).toHaveLength(5); expect(result.probes.every((row) => row.status === "ok")).toBe(true);
    expect(options.assertEligible).toHaveBeenCalledTimes(2); expect(options.assertCurrentVersion).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain(options.adminSecret);
    const calls = options.fetcher.mock.calls as unknown as Array<[URL, RequestInit]>;
    expect(calls.map(([url, init]) => [url.pathname, init.method])).toEqual([
      ["/api/dashboard", "GET"], ["/api/dashboard", "GET"], ["/api/breadth/dashboard", "GET"], ["/api/breadth/dashboard", "GET"], ["/api/admin/eod/runtime-probe/coordinator", "POST"],
    ]);
    expect(calls.every(([, init]) => init.redirect === "error")).toBe(true);
    expect(calls.every(([, init]) => new Headers(init.headers).get("Authorization") === `Bearer ${options.adminSecret}`)).toBe(true);
    expect(JSON.stringify(options.states)).not.toContain(options.adminSecret);
  });
  it("does not send any traffic when readiness fails or the destination is production", async () => {
    const options = await fixture(); options.assertEligible.mockRejectedValueOnce(new Error("missing-publication"));
    await expect(runCandidateProbes(options)).rejects.toThrow("missing-publication"); expect(options.fetcher).not.toHaveBeenCalled();
    await expect(runCandidateProbes({ ...options, baseUrl: "https://production.unit.workers.dev" })).rejects.toThrow("origin-invalid");
  });
  it("stops on provider/quota HTTP failure and refuses to replay an ambiguous interrupted request", async () => {
    const options = await fixture(); options.fetcher.mockResolvedValueOnce(Response.json({ error: "quota" }, { status: 503 }));
    await expect(runCandidateProbes(options)).rejects.toThrow("collect-diagnostics"); expect(options.fetcher).toHaveBeenCalledOnce();
    expect(options.states.at(-1)?.probes[0].status).toBe("failed");
    options.fetcher.mockClear();
    await expect(runCandidateProbes({ ...options, state: options.states[0] })).rejects.toThrow("interrupted-probe");
    expect(options.fetcher).not.toHaveBeenCalled();
  });
  it("resumes completed samples without replay and retains the five-request bound", async () => {
    const options = await fixture(), complete = await runCandidateProbes(options); options.fetcher.mockClear();
    await runCandidateProbes({ ...options, state: complete }); expect(options.fetcher).not.toHaveBeenCalled();
  });
  it("correlates live requests with returned platform ray IDs and cannot resume them through a new stream", async () => {
    const options = await fixture();
    const liveRequests = ["/api/dashboard", "/api/dashboard", "/api/breadth/dashboard", "/api/breadth/dashboard", "/api/admin/eod/runtime-probe/coordinator"]
      .map((route, i) => ({ route, nonce: uuid(i + 40) }));
    let count = 0;
    options.fetcher.mockImplementation(async () => Response.json({ ok: true }, { headers: { "cf-ray": `${String(++count).padStart(16, "0")}-SYD` } }));
    const healthy = vi.fn(), result = await runCandidateProbes({ ...options, liveRequests, assertStreamHealthy: healthy });
    expect(result.probes.map(row => row.nonce)).toEqual(liveRequests.map(row => row.nonce));
    expect(result.probes.map(row => row.requestId)).toEqual([1, 2, 3, 4, 5].map(value => String(value).padStart(16, "0")));
    expect(healthy).toHaveBeenCalledTimes(10);
    const calls = options.fetcher.mock.calls as unknown as Array<[URL, RequestInit]>;
    expect(calls.map(([, init]) => new Headers(init.headers).get("x-eod-runtime-request-id"))).toEqual(liveRequests.map(row => row.nonce));
    options.fetcher.mockClear();
    await expect(runCandidateProbes({ ...options, state: result, liveRequests })).rejects.toThrow("fresh-five");
    expect(options.fetcher).not.toHaveBeenCalled();
  });
  it("stops before the next live request if its ray ID is absent or the stream disconnects", async () => {
    const options = await fixture(), liveRequests = ["/api/dashboard", "/api/dashboard", "/api/breadth/dashboard", "/api/breadth/dashboard", "/api/admin/eod/runtime-probe/coordinator"]
      .map((route, i) => ({ route, nonce: uuid(i + 40) }));
    await expect(runCandidateProbes({ ...options, liveRequests })).rejects.toThrow("collect-diagnostics");
    expect(options.fetcher).toHaveBeenCalledOnce();
    options.fetcher.mockClear();
    await expect(runCandidateProbes({ ...options, liveRequests, assertStreamHealthy: () => { throw new Error("stream-disconnected"); } })).rejects.toThrow("stream-disconnected");
    expect(options.fetcher).not.toHaveBeenCalled();
  });
});
