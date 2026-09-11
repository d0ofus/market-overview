import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "./helpers/sqlite-d1";
import { createStorageWorkflowQuiescence, storageGitHubRevocationKey, validateUnallocatedStorageRun } from "../src/market-storage-github-revocation";
import { claimStorageMigration, createStorageMigration, loadStorageMigration, type StorageMigrationIdentity } from "../src/market-storage-control";
import { storageHash } from "../src/market-storage-pages";

const repository = "test/repo", runId = "34569210842", origin = "a".repeat(40), next = "b".repeat(40);
const now = new Date("2026-09-11T07:00:00Z");
const migration: StorageMigrationIdentity = { id: "market-storage:revocation-test", sessionDate: "2026-09-08", codeRevision: origin,
  sourceDatabaseId: "00000000-0000-4000-8000-000000000001", targetDatabaseId: "00000000-0000-4000-8000-000000000002",
  historyDatabaseId: "00000000-0000-4000-8000-000000000003" };
const workflow = { id: 354087983, path: ".github/workflows/eod-storage-migration.yml" };
const ghost = () => ({ id: Number(runId), workflow_id: workflow.id, path: workflow.path, check_suite_id: 777,
  head_sha: origin, run_attempt: 1, event: "workflow_dispatch", head_branch: "main", status: "queued", conclusion: null,
  repository: { full_name: repository }, head_repository: { full_name: repository },
  created_at: "2026-09-11T06:16:04Z", updated_at: "2026-09-11T06:16:04Z", display_title: "EOD storage migration" });
function github(options: { mutateRun?: (index: number) => unknown; jobs?: unknown; other?: boolean; incomplete?: boolean } = {}) {
  let inspections = 0;
  return vi.fn(async (path: string): Promise<unknown> => {
    if (path.endsWith("/workflows/eod-storage-migration.yml")) return workflow;
    if (path.endsWith(`/runs/${runId}`)) return options.mutateRun?.(++inspections) ?? ghost();
    if (path.includes(`/runs/${runId}/jobs?`)) {
      expect(path).toContain("filter=all");
      return options.jobs ?? { total_count: 0, jobs: [] };
    }
    if (path.includes("/workflows/") && path.includes("/runs?")) {
      const url = new URL(`https://api.github.com/${path}`), status = url.searchParams.get("status");
      expect(url.searchParams.get("per_page")).toBe("100");
      const storage = path.includes("/eod-storage-migration.yml/");
      const rows = storage && (!status || status === "queued") ? [ghost(), ...(options.other ? [{ ...ghost(), id: 123 }] : [])] : [];
      return { total_count: rows.length + (options.incomplete && status === "queued" ? 1 : 0), workflow_runs: rows };
    }
    throw new Error("Unexpected GitHub read");
  });
}

describe("explicit empty GitHub storage-run revocation", () => {
  let sqlite: ReturnType<typeof createSqliteD1>;
  beforeEach(async () => { sqlite = createSqliteD1(); sqlite.migrate("ops-migrations"); await createStorageMigration(sqlite.db, migration, now); });
  afterEach(() => { sqlite.dispose(); });
  const guard = (readGitHub = github(), revokeRunId: string | undefined = runId) => createStorageWorkflowQuiescence({
    ops: sqlite.db, repository, migration, fromRevision: origin, codeRevision: next, revokeRunId, readGitHub, now: () => now,
  });

  it("requires exact repository, workflow, old reviewed head, attempt, queued state and no jobs", () => {
    const input = { run: ghost(), jobs: { total_count: 0, jobs: [] }, workflow, repository, runId, fromRevision: origin };
    expect(validateUnallocatedStorageRun(input)).toMatchObject({ runId, headRevision: origin, jobs: 0, attempt: 1 });
    for (const change of [{ status: "in_progress" }, { run_attempt: 2 }, { head_sha: next }, { workflow_id: 999 },
      { event: "push" }, { head_branch: "other" }, { conclusion: "cancelled" }, { check_suite_id: null },
      { repository: { full_name: "other/repo" } }, { path: ".github/workflows/eod-market-data.yml" }]) {
      expect(() => validateUnallocatedStorageRun({ ...input, run: { ...ghost(), ...change } })).toThrow("unallocated-run-evidence-invalid");
    }
    expect(() => validateUnallocatedStorageRun({ ...input, jobs: { total_count: 1, jobs: [] } })).toThrow("unallocated-run-evidence-invalid");
  });

  it("records immutable truthful evidence after two checks and preserves it on replay", async () => {
    const read = github(), check = guard(read);
    await check();
    const key = storageGitHubRevocationKey(runId), before = await sqlite.db.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?").bind(key).first<string>("evidence_json");
    const record = JSON.parse(before!);
    expect(record).toMatchObject({ dispatchInputsVerified: false, scope: "github-run-id-all-migrations", operatorMigration: migration,
      snapshot: { runId, jobs: 0, checkSuiteId: 777 }, firstCheckedAt: now.toISOString(), secondCheckedAt: now.toISOString() });
    await check();
    expect(await sqlite.db.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?").bind(key).first("evidence_json")).toBe(before);
    expect(read.mock.calls.filter(([path]) => path.endsWith(`/runs/${runId}`))).toHaveLength(4);
    expect((await loadStorageMigration(sqlite.db, migration.id))?.status).toBe("queued");
  });

  it.each([undefined,runId])("reuses an earlier transition's exact revocation without rewriting it (explicit ID: %s)", async revokeRunId => {
    await guard()();
    const key=storageGitHubRevocationKey(runId);
    const before=await sqlite.db.prepare("SELECT evidence_json,updated_at FROM eod_rollout_evidence WHERE id=?").bind(key).first();
    const read=github(),assertRevokedRunClaimFence=vi.fn(async () => undefined);
    const check=createStorageWorkflowQuiescence({ops:sqlite.db,repository,migration,fromRevision:next,codeRevision:"c".repeat(40),
      revokeRunId,readGitHub:read,now:()=>new Date(now.getTime()+60_000),assertRevokedRunClaimFence});
    await check();
    expect(assertRevokedRunClaimFence).toHaveBeenCalledOnce();
    expect(read.mock.calls.filter(([path]) => path.endsWith(`/runs/${runId}`))).toHaveLength(2);
    expect(await sqlite.db.prepare("SELECT evidence_json,updated_at FROM eod_rollout_evidence WHERE id=?").bind(key).first()).toEqual(before);
    await sqlite.db.prepare("UPDATE market_storage_migrations SET execution_revision=? WHERE id=?").bind(next,migration.id).run();
    expect(await claimStorageMigration(sqlite.db,migration.id,{githubRunId:runId,executionRevision:next,now})).toBeNull();
  });

  it("requires the actual current executor's deny fence before prior-transition reuse", async () => {
    await guard()();
    const input={ops:sqlite.db,repository,migration,fromRevision:next,codeRevision:"c".repeat(40),readGitHub:github()};
    await expect(createStorageWorkflowQuiescence(input)()).rejects.toThrow("revoked-run-claim-fence-required");
    const reject=vi.fn(async () => {throw new Error("reviewed-current-claim-denial-missing");});
    await expect(createStorageWorkflowQuiescence({...input,assertRevokedRunClaimFence:reject})()).rejects.toThrow("reviewed-current-claim-denial-missing");
  });

  it("rejects a corrupt record, mismatched key/repository/head, or a disappeared denial on later reuse", async () => {
    await guard()();
    const key=storageGitHubRevocationKey(runId);
    const original=(await sqlite.db.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?").bind(key).first<string>("evidence_json"))!;
    const later=(readGitHub:(path:string)=>Promise<unknown>=github())=>createStorageWorkflowQuiescence({ops:sqlite.db,repository,migration,fromRevision:next,
      codeRevision:"c".repeat(40),readGitHub,assertRevokedRunClaimFence:async()=>undefined});
    for (const change of ["hash","key","repository","head"]) {
      const parsed=JSON.parse(original) as Record<string,unknown>;
      const snapshot={...parsed.snapshot as Record<string,unknown>};
      if(change==="key")snapshot.runId="123";
      if(change==="repository")snapshot.repository="other/repo";
      if(change==="head")parsed.fromRevision=next;
      const changedRecord:Record<string,unknown>={...parsed,snapshot};
      const {evidenceHash:_,...unsigned}=changedRecord;
      const changed={...unsigned,evidenceHash:change==="hash" ? "0".repeat(64) : await storageHash(unsigned)};
      await sqlite.db.prepare("UPDATE eod_rollout_evidence SET evidence_json=? WHERE id=?").bind(JSON.stringify(changed),key).run();
      await expect(later()()).rejects.toThrow(/run-revocation-record-(invalid|conflict)/);
    }
    await sqlite.db.prepare("UPDATE eod_rollout_evidence SET evidence_json=? WHERE id=?").bind(original,key).run();
    const read=github();
    await expect(later(async path => {
      if(path.includes("/workflows/eod-market-data.yml/runs?per_page=100")) {
        await sqlite.db.prepare("DELETE FROM eod_rollout_evidence WHERE id=?").bind(key).run();
      }
      return read(path);
    })()).rejects.toThrow("run-revocation-record-conflict");
  });

  it("blocks allocated, changed, or competing writers despite an older valid revocation", async () => {
    await guard()();
    const check=(readGitHub:ReturnType<typeof github>)=>createStorageWorkflowQuiescence({ops:sqlite.db,repository,migration,
      fromRevision:next,codeRevision:"c".repeat(40),readGitHub,assertRevokedRunClaimFence:async()=>undefined});
    for(const change of [{updated_at:"2026-09-11T06:17:00Z"},{check_suite_id:778},{head_sha:next}]) {
      await expect(check(github({mutateRun:()=>({...ghost(),...change})}))()).rejects.toThrow(/record-conflict|evidence-invalid/);
      await expect(check(github({mutateRun:index=>index===1 ? ghost() : {...ghost(),...change}}))()).rejects.toThrow(/evidence-(changed|invalid)/);
    }
    await expect(check(github({jobs:{total_count:1,jobs:[{id:1,status:"queued"}]}}))()).rejects.toThrow("evidence-invalid");
    await expect(check(github({other:true}))()).rejects.toThrow("workflow-writer-active");
    await expect(check(github({incomplete:true}))()).rejects.toThrow("workflow-inventory-invalid");
  });

  it("never ignores another writer or an incomplete filtered inventory", async () => {
    await expect(guard(github({ other: true }))()).rejects.toThrow("workflow-writer-active");
    await expect(guard(github({ incomplete: true }))()).rejects.toThrow("workflow-inventory-invalid");
    const noException = createStorageWorkflowQuiescence({ ops: sqlite.db, repository, migration,
      fromRevision: origin, codeRevision: next, readGitHub: github(), now: () => now });
    await expect(noException()).rejects.toThrow("workflow-writer-active");
    expect(await sqlite.db.prepare("SELECT COUNT(*) AS count FROM eod_rollout_evidence").first("count")).toBe(0);
  });

  it("rejects metadata/state/allocation changes between checks without persisting a revocation", async () => {
    for (const change of [{ updated_at: "2026-09-11T06:17:00Z" }, { check_suite_id: 778 }, { status: "in_progress" }]) {
      await expect(guard(github({ mutateRun: index => index === 1 ? ghost() : { ...ghost(), ...change } }))())
        .rejects.toThrow(/unallocated-run-evidence-(changed|invalid)/);
    }
    await expect(guard(github({ jobs: { total_count: 1, jobs: [{ id: 1, status: "queued" }] } }))()).rejects.toThrow("unallocated-run-evidence-invalid");
    expect(await sqlite.db.prepare("SELECT COUNT(*) AS count FROM eod_rollout_evidence").first("count")).toBe(0);
  });

  it("atomically denies a revoked run on every migration, while permitting a different run", async () => {
    await guard()();
    expect(await claimStorageMigration(sqlite.db, migration.id, { githubRunId: runId, executionRevision: origin, now })).toBeNull();
    const other = { ...migration, id: "market-storage:another-input" };
    await createStorageMigration(sqlite.db, other, now);
    expect(await claimStorageMigration(sqlite.db, other.id, { githubRunId: runId, executionRevision: origin, now })).toBeNull();
    expect(await claimStorageMigration(sqlite.db, migration.id, { githubRunId: "34569828764", executionRevision: origin, now })).not.toBeNull();
    // Local operator claims retain their existing independent authorization.
    expect(await claimStorageMigration(sqlite.db, other.id, { executionRevision: origin, now })).not.toBeNull();
  });

  it("fails closed for a malformed present ID or tampered revocation record", async () => {
    for (const githubRunId of ["", "0", "123x", " 123", "1,2"]) {
      await expect(claimStorageMigration(sqlite.db, migration.id, { githubRunId, now })).rejects.toThrow("invalid-github-run");
      expect(() => guard(github(), githubRunId)).toThrow("run-revocation-identity-invalid");
    }
    await guard()();
    await sqlite.db.prepare("UPDATE eod_rollout_evidence SET evidence_json='{}' WHERE id=?").bind(storageGitHubRevocationKey(runId)).run();
    await expect(guard()()).rejects.toThrow("run-revocation-record-invalid");
    expect(await claimStorageMigration(sqlite.db, migration.id, { githubRunId: runId, executionRevision: origin, now })).toBeNull();
  });

  it("retains the atomic old-revision fence if approval wins after the runner's initial read", async () => {
    const previouslyRead = (await loadStorageMigration(sqlite.db, migration.id))!;
    expect(previouslyRead.code_revision).toBe(origin);
    await sqlite.db.prepare("UPDATE market_storage_migrations SET execution_revision=? WHERE id=?").bind(next, migration.id).run();
    expect(await claimStorageMigration(sqlite.db, migration.id, { githubRunId: runId, executionRevision: previouslyRead.code_revision, now })).toBeNull();
    expect(await claimStorageMigration(sqlite.db, migration.id, { githubRunId: "34569828764", executionRevision: next, now })).not.toBeNull();
  });
});
