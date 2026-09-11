import { describe, expect, it, vi } from "vitest";
import { buildRuntimeEvidence, collectRuntimeEvidence, validateRuntimeEvidence, type RuntimeEvidenceIdentity } from "../src/eod-runtime-evidence";
import { eodHash } from "../src/eod-publication-service";
import { EOD_RUNTIME_COORDINATOR_PATH, type RuntimeProbeSummary } from "../src/eod-runtime-telemetry";
const uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const identity:RuntimeEvidenceIdentity={probeId:"probe",workerName:"candidate",workerVersion:uuid(1),codeRevision:"a".repeat(40),
  targetDatabaseId:uuid(2),historyDatabaseId:uuid(3),opsDatabaseId:uuid(4),coreDatabaseId:uuid(5)};
const bindings={DB:identity.coreDatabaseId,MARKET_DATA_DB:identity.targetDatabaseId,MARKET_HISTORY_DB:identity.historyDatabaseId,OPS_DB:identity.opsDatabaseId,
  EOD_READ_ENABLED:"true",EOD_RUNTIME_CANDIDATE_ONLY:"true",EOD_RUNTIME_PROBE_ID:"probe",EOD_CODE_REVISION:identity.codeRevision,EOD_RUNTIME_TARGET_DATABASE_ID:identity.targetDatabaseId};
const version=()=>({id:identity.workerVersion,resources:{bindings:Object.entries(bindings).map(([name,value])=>
  ["DB","MARKET_DATA_DB","MARKET_HISTORY_DB","OPS_DB"].includes(name)?{name,type:"d1",id:value,database_id:value}:{name,type:"plain_text",text:value})}});
const window={from:Date.parse("2026-09-10T01:00:00Z"),to:Date.parse("2026-09-10T02:00:00Z")};
function fixture() {
  return ["/api/dashboard","/api/dashboard","/api/breadth/dashboard","/api/breadth/dashboard",EOD_RUNTIME_COORDINATOR_PATH].flatMap((route,i)=>{
    const summary:RuntimeProbeSummary={event:"eod-runtime-probe-v1",probeId:"probe",sampleId:uuid(i+10),category:i===4?"coordinator":"http",route,
      codeRevision:identity.codeRevision,workerVersion:identity.workerVersion,targetDatabaseId:identity.targetDatabaseId,eodReadEnabled:true,
      startedAt:"2026-09-10T01:10:00.000Z",finishedAt:"2026-09-10T01:10:01.000Z",outcome:"ok",complete:true,cpuSource:"cloudflare-invocation-log-required",
      stats:{queries:i+10,rowsRead:20,rowsWritten:5,maxQueryDurationMs:i+0.5,failedQueries:0,missingMetadata:0}};
    const workers={requestId:`request-${i}`,scriptName:identity.workerName,scriptVersion:{id:identity.workerVersion}};
    return [{source:JSON.stringify(summary),$workers:workers},{source:"invocation",$workers:{...workers,cpuTimeMs:i+1,outcome:"ok",wallTimeMs:10000}}];
  });
}
describe("raw invocation evidence",()=>{
  it("binds paid runtime measurements to the actual deployed budget profile",async()=>{
    const paidIdentity={...identity,budgetProfile:"paid" as const};
    const paidVersion=version();
    paidVersion.resources.bindings.push({name:"EOD_BUDGET_PROFILE",type:"plain_text",text:"paid"});
    const artifact=await buildRuntimeEvidence(paidIdentity,paidVersion,fixture(),window,true);
    expect(await validateRuntimeEvidence(artifact,paidIdentity)).toEqual(artifact);
    await expect(buildRuntimeEvidence(paidIdentity,version(),fixture(),window,true)).rejects.toThrow("EOD_BUDGET_PROFILE");
    await expect(buildRuntimeEvidence(identity,paidVersion,fixture(),window,true)).rejects.toThrow("EOD_BUDGET_PROFILE");
    await expect(validateRuntimeEvidence(artifact,identity)).rejects.toThrow("identity-mismatch");
  });
  it("derives real maxima from correlated CPU and per-invocation D1 counters only",async()=>{
    const artifact=await buildRuntimeEvidence(identity,version(),fixture(),window,true);
    expect(await validateRuntimeEvidence(artifact,identity)).toEqual(artifact);
    expect(artifact.measurements).toEqual({httpCpuMs:4,coordinatorCpuMs:5,queriesPerInvocation:14,queryDurationMs:4.5});
    expect(JSON.stringify(artifact)).not.toContain("wallTimeMs");
  });
  it("rejects legacy readers, wrong history, duplicates, conflicting IDs and wrong code/version",async()=>{
    for(const name of ["EOD_READ_ENABLED","MARKET_HISTORY_DB","EOD_CODE_REVISION"]) {
      const changed=version(),row=changed.resources.bindings.find((row)=>row.name===name)!;
      if("text" in row)row.text="wrong";else row.id=row.database_id=uuid(99);
      await expect(buildRuntimeEvidence(identity,changed,fixture(),window,true)).rejects.toThrow("binding-mismatch");
    }
    const duplicate=version();duplicate.resources.bindings.push(duplicate.resources.bindings[0]);
    await expect(buildRuntimeEvidence(identity,duplicate,fixture(),window,true)).rejects.toThrow("duplicate");
    const conflicting=version();conflicting.resources.bindings[0].database_id=uuid(99);
    await expect(buildRuntimeEvidence(identity,conflicting,fixture(),window,true)).rejects.toThrow("conflicting-id");
    await expect(buildRuntimeEvidence(identity,{...version(),id:uuid(99)},fixture(),window,true)).rejects.toThrow("version-mismatch");
  });
  it("leaves absent CPU, missing coordinator, and truncated windows pending without invented zeros",async()=>{
    const events=fixture().filter((row)=>row.source!=="invocation"),absent=await buildRuntimeEvidence(identity,version(),events,window,true);
    expect(absent.complete).toBe(false);expect(absent.measurements.httpCpuMs).toBeNull();
    expect((await buildRuntimeEvidence(identity,version(),fixture().slice(0,8),window,true)).complete).toBe(false);
    await expect(validateRuntimeEvidence(await buildRuntimeEvidence(identity,version(),fixture(),window,false),identity)).rejects.toThrow("incomplete");
    const withFailure=[...fixture(),{source:"invocation",$workers:{requestId:"failed-without-summary",scriptName:identity.workerName,
      scriptVersion:{id:identity.workerVersion},outcome:"exceededCpu",cpuTimeMs:51}}];
    expect((await buildRuntimeEvidence(identity,version(),withFailure,window,true)).complete).toBe(false);
    for(const extra of [{outcome:"ok",cpuTimeMs:3},{outcome:"ok"}]) {
      const unmatched=[...fixture(),{source:"invocation",$workers:{requestId:"unmatched",scriptName:identity.workerName,
        scriptVersion:{id:identity.workerVersion},...extra}}];
      expect((await buildRuntimeEvidence(identity,version(),unmatched,window,true)).complete).toBe(false);
    }
  });
  it("rejects altered metrics even when a supplied file recomputes its own hash",async()=>{
    const artifact=await buildRuntimeEvidence(identity,version(),fixture(),window,true);artifact.measurements.httpCpuMs=0;
    const {evidenceHash:_,...body}=artifact;artifact.evidenceHash=await eodHash(body);
    await expect(validateRuntimeEvidence(artifact,identity)).rejects.toThrow("measurement-mismatch");
  });
  it("uses authenticated fixed API calls and treats reported total beyond returned records as incomplete",async()=>{
    const fetcher=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>Response.json({success:true,result:init?.method==="GET"?version():{events:{events:fixture(),count:11}}}));
    const artifact=await collectRuntimeEvidence({accountId:"a".repeat(32),token:"private-unit-token",identity,...window,fetcher});
    expect(artifact.complete).toBe(false);expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(artifact)).not.toContain("private-unit-token");
  });
});
