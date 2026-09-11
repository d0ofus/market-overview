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
    const workers={requestId:`request-${i}`,scriptName:identity.workerName,scriptVersion:{id:identity.workerVersion},eventType:"fetch"};
    const shared={dataset:"cloudflare-workers",timestamp:Date.parse(summary.finishedAt)};
    return [{...shared,source:i%2?summary:JSON.stringify(summary),$workers:workers,
      $metadata:{id:`summary-${i}`,type:"cf-worker-log",service:identity.workerName,requestId:workers.requestId}},
    {...shared,source:"invocation",$metadata:{id:`invocation-${i}`,type:"cf-worker-event",service:identity.workerName,requestId:workers.requestId},
      $workers:{...workers,cpuTimeMs:i+1,outcome:"ok",wallTimeMs:10000}}];
  });
}
function queryFixture() {
  const events=fixture(),statistics={bytes_read:1024,elapsed:0.025,rows_read:events.length};
  return {run:{id:"query-run",accountId:"a".repeat(32),dry:true,granularity:60,
    query:{id:`eod-runtime-${identity.probeId}`,adhoc:true,parameters:{datasets:["cloudflare-workers"]}},
    status:"COMPLETED",timeframe:window,userId:"operator",statistics},statistics,
    events:{count:events.length,events,fields:[],series:[]}};
}
function collectResult(result:unknown) {
  const fetcher=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>Response.json({success:true,result:init?.method==="GET"?version():result}));
  return {fetcher,promise:collectRuntimeEvidence({accountId:"a".repeat(32),token:"private-unit-token",identity,...window,fetcher})};
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
    const withFailure=[...fixture(),{source:"invocation",$metadata:{type:"cf-worker-event"},$workers:{requestId:"failed-without-summary",scriptName:identity.workerName,
      scriptVersion:{id:identity.workerVersion},outcome:"exceededCpu",cpuTimeMs:51}}];
    expect((await buildRuntimeEvidence(identity,version(),withFailure,window,true)).complete).toBe(false);
    for(const extra of [{outcome:"ok",cpuTimeMs:3},{outcome:"ok"}]) {
      const unmatched=[...fixture(),{source:"invocation",$metadata:{type:"cf-worker-event"},$workers:{requestId:"unmatched",scriptName:identity.workerName,
        scriptVersion:{id:identity.workerVersion},...extra}}];
      expect((await buildRuntimeEvidence(identity,version(),unmatched,window,true)).complete).toBe(false);
    }
  });
  it("does not mistake ordinary custom logs carrying outcome for invocation CPU records",async()=>{
    const event=fixture()[0];
    const custom={...event,source:{message:"read completed"},$metadata:{...event.$metadata,id:"ordinary-log"},
      $workers:{...event.$workers,outcome:"ok"}};
    expect((await buildRuntimeEvidence(identity,version(),[...fixture(),custom],window,true)).complete).toBe(true);
    // Even a CPU-looking field on a custom log cannot replace platform evidence.
    const fabricated=fixture().map(row=>row.source==="invocation"?{...row,$metadata:{...row.$metadata,type:"cf-worker-log"}}:row);
    expect((await buildRuntimeEvidence(identity,version(),fabricated,window,true)).measurements.httpCpuMs).toBeNull();
    expect((await buildRuntimeEvidence(identity,version(),[...fixture(),{...custom,$workers:{...custom.$workers,outcome:"exception"}}],window,true)).complete).toBe(false);
  });
  it("requires exact version, request identity, a single invocation and CPU even when application summaries exist",async()=>{
    for(const altered of [
      fixture().map(row=>row.source==="invocation"?{...row,$workers:{...row.$workers,scriptVersion:{id:uuid(99)}}}:row),
      fixture().map(row=>row.source==="invocation"?{...row,$workers:{...row.$workers,requestId:"other"},$metadata:{...row.$metadata,requestId:"other"}}:row),
      [...fixture(),fixture()[1]],
      fixture().map(row=>row.source==="invocation"?{...row,$workers:{...row.$workers,cpuTimeMs:undefined}}:row),
    ])expect((await buildRuntimeEvidence(identity,version(),altered,window,true)).complete).toBe(false);
  });
  it("rejects altered metrics even when a supplied file recomputes its own hash",async()=>{
    const artifact=await buildRuntimeEvidence(identity,version(),fixture(),window,true);artifact.measurements.httpCpuMs=0;
    const {evidenceHash:_,...body}=artifact;artifact.evidenceHash=await eodHash(body);
    await expect(validateRuntimeEvidence(artifact,identity)).rejects.toThrow("measurement-mismatch");
  });
  it("uses authenticated fixed API calls and treats reported total beyond returned records as incomplete",async()=>{
    const result=queryFixture();result.events.count=11;
    const {fetcher,promise}=collectResult(result),artifact=await promise;
    expect(artifact.complete).toBe(false);expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(artifact)).not.toContain("private-unit-token");
  });
  it("accepts the official nested response with a completed unsampled query and unique event cursors",async()=>{
    for(const abr of [undefined,1]) {
      const result=queryFixture();Object.assign(result.statistics,{abr_level:abr});
      const {fetcher,promise}=collectResult(result),artifact=await promise;
      expect(await validateRuntimeEvidence(artifact,identity)).toEqual(artifact);
      const [url,init]=fetcher.mock.calls[1];
      expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/workers/observability/telemetry/query`);
      expect(JSON.parse(String(init?.body))).toEqual({queryId:"eod-runtime-probe",view:"events",limit:2000,dry:true,timeframe:window,
        parameters:{datasets:["cloudflare-workers"],filterCombination:"and",filters:[{key:"$metadata.service",operation:"eq",type:"string",value:"candidate"}]}});
    }
  });
  it("keeps unfinished or adaptively sampled queries incomplete even when counts match",async()=>{
    const pending=queryFixture();pending.run.status="STARTED";
    expect((await collectResult(pending).promise).unavailableReasons).toContain("runtime-log-query-not-completed");
    for(const field of ["statistics","run"] as const) {
      const result=queryFixture();
      if(field==="statistics")Object.assign(result.statistics,{abr_level:2});
      else result.run.statistics={...result.run.statistics,...{abr_level:2}};
      expect((await collectResult(result).promise).unavailableReasons).toContain("runtime-log-query-sampled");
    }
  });
  it("does not infer full coverage from absent totals, duplicate cursors or a full result page",async()=>{
    const missing=queryFixture();
    expect((await collectResult({...missing,events:{events:missing.events.events}}).promise).complete).toBe(false);
    const duplicate=queryFixture();duplicate.events.events[1].$metadata.id=duplicate.events.events[0].$metadata.id;
    expect((await collectResult(duplicate).promise).unavailableReasons).toContain("runtime-log-query-duplicate-events");
    const full=queryFixture();full.events.events=Array.from({length:2000},(_,i)=>({...full.events.events[0],
      source:"ordinary log",$metadata:{...full.events.events[0].$metadata,id:`event-${i}`}}));full.events.count=2000;
    expect((await collectResult(full).promise).unavailableReasons).toContain("runtime-log-query-truncated");
  });
  it("rejects undocumented array responses and missing query statistics without accepting an artifact",async()=>{
    const result=queryFixture();
    for(const malformed of [{events:fixture()}, {...result,run:undefined}, {...result,statistics:undefined}]) {
      await expect(collectResult(malformed).promise).rejects.toThrow("runtime-cloudflare-query-metadata-unavailable");
    }
    for(const row of [{dataset:"another-dataset"},{timestamp:window.from-1}]) {
      const invalid=queryFixture();Object.assign(invalid.events.events[0],row);
      expect((await collectResult(invalid).promise).unavailableReasons).toContain("runtime-log-query-event-scope-mismatch");
    }
  });
});
