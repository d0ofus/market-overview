import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "./helpers/sqlite-d1";
import { emptyRuntimeStats, isEodRuntimeHttpProbe, observeRuntimeDatabase, runEodRuntimeProbe, type RuntimeProbeSummary } from "../src/eod-runtime-telemetry";
import type { Env } from "../src/types";

const version="00000000-0000-4000-8000-000000000001",target="00000000-0000-4000-8000-000000000002";
const env=(db={} as D1Database):Env=>({DB:db,OPS_DB:db,ADMIN_SECRET:"unit-test-secret",EOD_RUNTIME_PROBE_ID:"test-probe",
  EOD_RUNTIME_PROBE_UNTIL:new Date(Date.now()+3600_000).toISOString(),EOD_CODE_REVISION:"a".repeat(40),
  EOD_VERSION_METADATA:{id:version},EOD_RUNTIME_TARGET_DATABASE_ID:target,EOD_READ_ENABLED:"true"});
const request=(path="/api/dashboard",headers:Record<string,string>={authorization:"Bearer unit-test-secret","x-eod-runtime-probe":"test-probe"})=>
  new Request(`https://test.invalid${path}`,{headers});
afterEach(()=>vi.restoreAllMocks());
describe("bounded runtime probe",()=>{
  it("defaults off and requires secret, exact auth, probe ID, fixed routes and a live bounded window",()=>{
    expect(isEodRuntimeHttpProbe(request(),env())).toBe(true);
    expect(isEodRuntimeHttpProbe(request(),{DB:{} as D1Database})).toBe(false);
    for(const patch of [{ADMIN_SECRET:undefined},{ADMIN_SECRET:"wrong"},{EOD_RUNTIME_PROBE_ID:"other"},
      {EOD_RUNTIME_PROBE_UNTIL:new Date(Date.now()-1).toISOString()},{EOD_RUNTIME_PROBE_UNTIL:new Date(Date.now()+172800_000).toISOString()},
      {EOD_VERSION_METADATA:undefined}])expect(isEodRuntimeHttpProbe(request(),{...env(),...patch})).toBe(false);
    expect(isEodRuntimeHttpProbe(request("/api/dashboard",{}),env())).toBe(false);
    expect(isEodRuntimeHttpProbe(request("/api/breadth/dashboard?historyLimit=1"),env())).toBe(false);
    expect(isEodRuntimeHttpProbe(request("/api/admin/run-eod"),env())).toBe(false);
    expect(isEodRuntimeHttpProbe(new Request("https://test.invalid/api/admin/eod/runtime-probe/coordinator",{method:"POST",headers:{authorization:"Bearer unit-test-secret","x-eod-runtime-probe":"test-probe"}}),env())).toBe(true);
  });
  it("counts actual statements, preserves first and binds, and takes actual maximum SQL duration",async()=>{
    const results=(n:number)=>({success:true,results:[{secretValue:n}],meta:{rows_read:1,rows_written:0,duration:n,size_after:1024}});
    const native={prepare:()=>{let n=1;const statement={bind:(value:number)=>{n=value;return statement;},all:async()=>results(n)};return statement;},
      batch:async(statements:Array<{all:()=>Promise<unknown>}>)=>Promise.all(statements.map((row)=>row.all()))} as unknown as D1Database;
    const stats=emptyRuntimeStats(),db=observeRuntimeDatabase(native,stats);
    expect(await db.prepare("SELECT secretValue").bind(4).first("secretValue")).toBe(4);
    await db.batch([db.prepare("SELECT secretValue").bind(2),db.prepare("SELECT secretValue").bind(8)]);
    expect(stats).toEqual({queries:3,rowsRead:3,rowsWritten:0,maxQueryDurationMs:8,missingMetadata:0,failedQueries:0});
    expect(JSON.stringify(stats)).not.toContain("secretValue");
    await expect(db.prepare("SELECT 1").raw()).rejects.toThrow("unsupported");
  });
  it("persists the 24 sample cap, counts control statements, and never marks absent timing as measured",async()=>{
    const sqlite=createSqliteD1();sqlite.migrate("ops-migrations");
    try {
      const settings=env(sqlite.db),summaries:RuntimeProbeSummary[]=[],action=vi.fn(async(observed:Env)=>observed.DB.prepare("SELECT 1 AS value").first());
      await runEodRuntimeProbe(settings,"http","/api/dashboard",action,(summary)=>summaries.push(summary));
      await sqlite.db.prepare("UPDATE eod_rollout_evidence SET evidence_json=json_set(evidence_json,'$.claimed',23) WHERE id=?").bind("eod-runtime-counter:test-probe").run();
      await runEodRuntimeProbe(settings,"http","/api/dashboard",action,(summary)=>summaries.push(summary));
      await expect(runEodRuntimeProbe(settings,"http","/api/dashboard",action)).rejects.toThrow("sample-limit");
      expect(action).toHaveBeenCalledTimes(2);
      expect(summaries[0]).toMatchObject({complete:false,cpuSource:"cloudflare-invocation-log-required"});
      expect(summaries[0].stats.queries).toBeGreaterThan(3);
      const stored=await sqlite.db.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id LIKE 'eod-runtime:test-probe:%'").all<{evidence_json:string}>();
      expect(stored.results).toHaveLength(2);
      expect(stored.results.every((row)=>JSON.parse(row.evidence_json).complete===false)).toBe(true);
      expect(await sqlite.db.prepare("SELECT COUNT(*) AS count FROM eod_budget_reservations WHERE settled=0").first("count")).toBe(0);
    } finally {sqlite.dispose();}
  },30_000);
});
