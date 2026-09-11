import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createCapacityLocalSqlite } from "../scripts/eod-capacity-local-sqlite";
import { requeueStorageBootstrapCorrection } from "../src/market-storage-bootstrap-correction";
import { EOD_METRICS_VERSION } from "../src/eod-metrics";
import type { FrozenInputs } from "../src/eod-runner";
import type { Env } from "../src/types";

describe("owned same-session private bootstrap correction", () => {
  let directory: string, ops: ReturnType<typeof createCapacityLocalSqlite>, market: ReturnType<typeof createCapacityLocalSqlite>, env: Env;
  const now = new Date("2026-09-11T22:00:00Z"), id = "market-storage:correction", runId = "eod:active:2026-09-11:daily";
  const targetDatabaseId = "10000000-0000-0000-0000-000000000002", planHash = "a".repeat(64), lease = "migration-lease";
  const plannedInputs = { tickers: ["AAA"], calendarDates: ["2026-09-10", "2026-09-11"], memberships: [], config: {}, methodologyVersion: EOD_METRICS_VERSION } as unknown as FrozenInputs;
  const input = { migrationId: id, migrationLeaseToken: lease, planHash, targetDatabaseId, runId, sessionDate: "2026-09-11", plannedInputs, now };
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(),"storage-correction-test-"));
    ops = createCapacityLocalSqlite(join(directory,"ops.sqlite")); market = createCapacityLocalSqlite(join(directory,"market.sqlite"));
    const migrations = resolve("ops-migrations");
    await ops.script(readdirSync(migrations).filter(name=>name.endsWith(".sql")).sort().map(name=>readFileSync(join(migrations,name),"utf8")).join("\n"));
    await market.script("CREATE TABLE eod_input_clock(id TEXT PRIMARY KEY,revision INTEGER); INSERT INTO eod_input_clock VALUES('default',11); CREATE TABLE eod_publications(id TEXT PRIMARY KEY,payload TEXT); INSERT INTO eod_publications VALUES('accepted-old','original');");
    await ops.db.prepare(`INSERT INTO market_storage_migrations(id,source_database_id,target_database_id,history_database_id,session_date,code_revision,status,stage,
      lease_token,lease_until,created_at,updated_at) VALUES(?,?,?,?,?,?,'running','bootstrap',?,?,?,?)`)
      .bind(id,"10000000-0000-0000-0000-000000000001",targetDatabaseId,"10000000-0000-0000-0000-000000000003","2026-09-08","b".repeat(40),lease,"2026-09-11T22:10:00Z",now.toISOString(),now.toISOString()).run();
    await ops.db.prepare(`INSERT INTO eod_runs(id,session_date,purpose,mode,status,stage,input_json,progress_json,completed_at,completed_input_clock,created_at,updated_at)
      VALUES(?,'2026-09-11','daily','active','completed','finished',?,'{"published":["accepted-old"]}',?,10,?,?)`)
      .bind(runId,JSON.stringify(plannedInputs),now.toISOString(),now.toISOString(),now.toISOString()).run();
    await ops.db.prepare("INSERT INTO market_storage_checkpoints(migration_id,checkpoint_key,input_hash,payload_json,updated_at) VALUES(?,'bootstrap:owner',?,?,?)")
      .bind(id,planHash,JSON.stringify({runId,sessionDate:input.sessionDate,targetDatabaseId}),now.toISOString()).run();
    env = { DB: market.db, MARKET_DATA_DB: market.db, OPS_DB: ops.db, EOD_RUNNER_MODE: "active", EOD_ARCHIVE_PRUNE_ENABLED: "false" } as Env;
  });
  afterEach(async()=>{await Promise.all([ops.close(),market.close()]);rmSync(directory,{recursive:true,force:true});});
  it("requeues the owned completed daily, preserving frozen inputs and every accepted publication", async()=>{
    const result = await requeueStorageBootstrapCorrection(env,input);
    expect(result).toMatchObject({status:"queued",stage:"inputs",completed_input_clock:null,input_json:JSON.stringify(plannedInputs)});
    expect(await market.db.prepare("SELECT payload FROM eod_publications WHERE id='accepted-old'").first("payload")).toBe("original");
    expect((await requeueStorageBootstrapCorrection(env,input)).status).toBe("queued");
  });
  it("leaves a completed run unchanged when its exact input clock is still current", async()=>{
    await market.db.prepare("UPDATE eod_input_clock SET revision=10 WHERE id='default'").run();
    expect((await requeueStorageBootstrapCorrection(env,input)).status).toBe("completed");
    expect(await ops.db.prepare("SELECT completed_at FROM eod_runs WHERE id=?").bind(runId).first("completed_at")).toBe(now.toISOString());
  });
  it.each(["lease","plan","target"] as const)("rejects a stale %s owner without resetting the completed run", async(kind)=>{
    const changed = {...input,...(kind==="lease" ? {migrationLeaseToken:"wrong"} : kind==="plan" ? {planHash:"f".repeat(64)} : {targetDatabaseId:"10000000-0000-0000-0000-000000000009"})};
    await expect(requeueStorageBootstrapCorrection(env,changed)).rejects.toThrow("owner-conflict");
    expect(await ops.db.prepare("SELECT status FROM eod_runs WHERE id=?").bind(runId).first("status")).toBe("completed");
  });
  it("rejects changed measured inputs and a regressed clock", async()=>{
    await expect(requeueStorageBootstrapCorrection(env,{...input,plannedInputs:{...plannedInputs,tickers:["OTHER"]}})).rejects.toThrow("inputs-mismatch");
    await market.db.prepare("UPDATE eod_input_clock SET revision=9 WHERE id='default'").run();
    await expect(requeueStorageBootstrapCorrection(env,input)).rejects.toThrow("clock-invalid");
  });
});
