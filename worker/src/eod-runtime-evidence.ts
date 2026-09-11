import { z } from "zod";
import { eodHash } from "./eod-publication-service";
import { EOD_RUNTIME_COORDINATOR_PATH, EOD_RUNTIME_HTTP_PATHS, EOD_RUNTIME_PROBE_LIMIT } from "./eod-runtime-telemetry";
import { resolveEodBudgetProfile } from "./eod-budget-profile";

const finite=z.number().finite().nonnegative();
const identitySchema=z.object({probeId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),workerName:z.string().min(1),
  workerVersion:z.string().uuid(),codeRevision:z.string().regex(/^[a-f0-9]{40}$/),targetDatabaseId:z.string().uuid(),
  historyDatabaseId:z.string().uuid(),opsDatabaseId:z.string().uuid(),coreDatabaseId:z.string().uuid(),
  budgetProfile:z.enum(["free","paid"]).optional()}).strict();
export type RuntimeEvidenceIdentity=z.infer<typeof identitySchema>;
const statsSchema=z.object({queries:finite.int(),rowsRead:finite.int(),rowsWritten:finite.int(),maxQueryDurationMs:finite,
  missingMetadata:finite.int(),failedQueries:finite.int()}).strict();
const summarySchema=z.object({event:z.literal("eod-runtime-probe-v1"),probeId:z.string(),sampleId:z.string().uuid(),
  category:z.enum(["http","coordinator"]),route:z.string(),codeRevision:z.string(),workerVersion:z.string(),targetDatabaseId:z.string(),
  eodReadEnabled:z.boolean(),startedAt:z.string().datetime(),finishedAt:z.string().datetime(),outcome:z.enum(["ok","error"]),
  complete:z.boolean(),stats:statsSchema,cpuSource:z.literal("cloudflare-invocation-log-required")}).strict();
const sampleSchema=z.object({summary:summarySchema,requestId:z.string().min(1),cpuTimeMs:finite,outcome:z.literal("ok")}).strict();
const artifactSchema=z.object({schemaVersion:z.literal(1),source:z.literal("cloudflare-workers-raw-invocation-logs"),
  identity:identitySchema,collectedAt:z.string().datetime(),window:z.object({from:finite,to:finite}).strict(),
  versionBindings:z.record(z.string()),complete:z.boolean(),unavailableReasons:z.array(z.string()),samples:z.array(sampleSchema).max(EOD_RUNTIME_PROBE_LIMIT),
  measurements:z.object({httpCpuMs:finite.nullable(),coordinatorCpuMs:finite.nullable(),queriesPerInvocation:finite.int().nullable(),
    queryDurationMs:finite.nullable()}).strict(),evidenceHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type RuntimeEvidence=z.infer<typeof artifactSchema>;
type LogEvent={source?:unknown;$metadata?:{requestId?:string;service?:string;id?:string;statusCode?:number;type?:string};
  $workers?:{requestId?:string;scriptName?:string;scriptVersion?:{id?:string};cpuTimeMs?:number;outcome?:string;truncated?:boolean;
    event?:{response?:{status?:number}}};timestamp?:number};
type Fetcher=typeof fetch;
function requiredBindings(id:RuntimeEvidenceIdentity):Record<string,string> {
  return {MARKET_DATA_DB:id.targetDatabaseId,MARKET_HISTORY_DB:id.historyDatabaseId,OPS_DB:id.opsDatabaseId,DB:id.coreDatabaseId,
    EOD_READ_ENABLED:"true",EOD_RUNTIME_CANDIDATE_ONLY:"true",
    EOD_RUNTIME_PROBE_ID:id.probeId,EOD_CODE_REVISION:id.codeRevision,EOD_RUNTIME_TARGET_DATABASE_ID:id.targetDatabaseId,
    ...(id.budgetProfile ? {EOD_BUDGET_PROFILE:id.budgetProfile} : {})};
}
function assertBindings(id:RuntimeEvidenceIdentity,bindings:Record<string,string>):void {
  for(const [name,value] of Object.entries(requiredBindings(id)))if(bindings[name]!==value)throw new Error(`runtime-version-binding-mismatch:${name}`);
  if(resolveEodBudgetProfile(bindings.EOD_BUDGET_PROFILE).name!==resolveEodBudgetProfile(id.budgetProfile).name) {
    throw new Error("runtime-version-binding-mismatch:EOD_BUDGET_PROFILE");
  }
}
function summarize(samples:RuntimeEvidence["samples"]):RuntimeEvidence["measurements"] {
  const maximum=(values:number[])=>values.length?Math.max(...values):null;
  return {httpCpuMs:maximum(samples.filter((row)=>row.summary.category==="http").map((row)=>row.cpuTimeMs)),
    coordinatorCpuMs:maximum(samples.filter((row)=>row.summary.category==="coordinator").map((row)=>row.cpuTimeMs)),
    queriesPerInvocation:maximum(samples.map((row)=>row.summary.stats.queries)),
    queryDurationMs:maximum(samples.map((row)=>row.summary.stats.maxQueryDurationMs))};
}
function coverage(samples:RuntimeEvidence["samples"]):string[] {
  return [...EOD_RUNTIME_HTTP_PATHS,EOD_RUNTIME_COORDINATOR_PATH].flatMap((route)=>{
    const count=samples.filter((row)=>row.summary.route===route).length,minimum=route===EOD_RUNTIME_COORDINATOR_PATH?1:2;
    return count<minimum?[`runtime-samples-missing:${route}:${count}/${minimum}`]:[];
  });
}
/** Strict local integrity validation. Acceptance must also re-collect from the
 * authenticated Cloudflare API; a locally supplied JSON file is not an attestation. */
export async function validateRuntimeEvidence(value:unknown,expected:RuntimeEvidenceIdentity):Promise<RuntimeEvidence> {
  const parsed=artifactSchema.parse(value);identitySchema.parse(expected);
  if(JSON.stringify(parsed.identity)!==JSON.stringify(identitySchema.parse(expected)))throw new Error("runtime-evidence-identity-mismatch");
  assertBindings(parsed.identity,parsed.versionBindings);
  const {evidenceHash,...body}=parsed;
  if(await eodHash(body)!==evidenceHash)throw new Error("runtime-evidence-hash-mismatch");
  if(!parsed.complete || parsed.unavailableReasons.length || coverage(parsed.samples).length)throw new Error("runtime-evidence-incomplete");
  const ids=new Set<string>(),requests=new Set<string>();
  for(const sample of parsed.samples) {
    const summary=sample.summary;
    if(ids.has(summary.sampleId)||requests.has(sample.requestId))throw new Error("runtime-evidence-duplicate-sample");
    ids.add(summary.sampleId);requests.add(sample.requestId);
    if(summary.probeId!==expected.probeId || summary.codeRevision!==expected.codeRevision || summary.workerVersion!==expected.workerVersion
      || summary.targetDatabaseId!==expected.targetDatabaseId || !summary.eodReadEnabled || !summary.complete || summary.outcome!=="ok"
      || summary.stats.missingMetadata || summary.stats.failedQueries || summary.stats.queries<1
      || Date.parse(summary.startedAt)<parsed.window.from || Date.parse(summary.finishedAt)>parsed.window.to
      || Date.parse(summary.finishedAt)<Date.parse(summary.startedAt)
      || (summary.category==="coordinator" ? summary.route!==EOD_RUNTIME_COORDINATOR_PATH : !EOD_RUNTIME_HTTP_PATHS.includes(summary.route as typeof EOD_RUNTIME_HTTP_PATHS[number])))
      throw new Error("runtime-evidence-invalid-sample");
  }
  if(JSON.stringify(summarize(parsed.samples))!==JSON.stringify(parsed.measurements))throw new Error("runtime-evidence-measurement-mismatch");
  return parsed;
}
function summaryFrom(source:unknown):z.infer<typeof summarySchema>|null {
  if(typeof source==="string"){try{source=JSON.parse(source);}catch{return null;}}
  const parsed=summarySchema.safeParse(source);return parsed.success?parsed.data:null;
}
/** Inputs are only the actual version API response and raw event API records.
 * Never accepts GraphQL percentiles, wall time or request-average ratios. */
export async function buildRuntimeEvidence(identity:RuntimeEvidenceIdentity,version:unknown,events:LogEvent[],window:{from:number;to:number},
  completeWindow:boolean,collectedAt=new Date().toISOString()):Promise<RuntimeEvidence> {
  identity=identitySchema.parse(identity);
  const deployment=z.object({id:z.string(),resources:z.object({bindings:z.array(z.object({name:z.string(),type:z.string(),
    id:z.string().optional(),database_id:z.string().optional(),text:z.string().optional()}))})}).parse(version);
  if(deployment.id!==identity.workerVersion)throw new Error("runtime-worker-version-mismatch");
  const versionBindings:Record<string,string>={};
  for(const binding of deployment.resources.bindings)if(Object.hasOwn(requiredBindings(identity),binding.name) || binding.name==="EOD_BUDGET_PROFILE") {
    if(Object.hasOwn(versionBindings,binding.name))throw new Error("runtime-binding-duplicate");
    if(["DB","MARKET_DATA_DB","MARKET_HISTORY_DB","OPS_DB"].includes(binding.name) ? binding.type!=="d1" : binding.type!=="plain_text")throw new Error("runtime-binding-type-mismatch");
    if(binding.id && binding.database_id && binding.id!==binding.database_id)throw new Error("runtime-binding-conflicting-id");
    versionBindings[binding.name]=binding.type==="d1"?(binding.database_id??binding.id??""):(binding.text??"");
  }
  assertBindings(identity,versionBindings);
  if(!Number.isFinite(window.from)||!Number.isFinite(window.to)||window.to<=window.from||window.to-window.from>86_400_000)throw new Error("runtime-invalid-window");
  const unavailableReasons=completeWindow?[]:["runtime-log-query-truncated"];
  const summaries=events.flatMap((event)=>{const summary=summaryFrom(event.source);return summary?.probeId===identity.probeId?[{event,summary}]:[];});
  const summaryRequests=new Set(summaries.map(({event})=>event.$workers?.requestId??event.$metadata?.requestId).filter(Boolean));
  // CPU exhaustion and pre-admission failures can prevent a final summary. Do
  // not cherry-pick the successful summaries from a failing candidate window.
  for(const event of events) {
    const worker=event.$workers;
    if(worker?.scriptName===identity.workerName && worker.scriptVersion?.id===identity.workerVersion
      && ((worker.outcome && worker.outcome!=="ok") || worker.truncated
        || (event.$metadata?.statusCode ?? worker.event?.response?.status ?? 0)>=500))
      unavailableReasons.push(`runtime-window-failed-invocation:${worker.requestId??"missing-request-id"}`);
    if(worker?.scriptName===identity.workerName && worker.scriptVersion?.id===identity.workerVersion
      && !summaryFrom(event.source) && (worker.outcome!==undefined || worker.cpuTimeMs!==undefined || event.$metadata?.type==="cf-worker-event")
      && (!worker.requestId || !summaryRequests.has(worker.requestId) || typeof worker.cpuTimeMs!=="number"
        || !Number.isFinite(worker.cpuTimeMs) || worker.cpuTimeMs<0))
      unavailableReasons.push(`runtime-window-unmatched-invocation:${worker.requestId??"missing-request-id"}`);
  }
  const samples:RuntimeEvidence["samples"]=[];
  for(const {event,summary} of summaries) {
    const requestId=event.$workers?.requestId??event.$metadata?.requestId;
    const correlated=events.filter((row)=>requestId && (row.$workers?.requestId??row.$metadata?.requestId)===requestId
      && row.$workers?.scriptName===identity.workerName && row.$workers?.scriptVersion?.id===identity.workerVersion
      && typeof row.$workers?.cpuTimeMs==="number" && Number.isFinite(row.$workers.cpuTimeMs) && row.$workers.cpuTimeMs>=0);
    if(!requestId || event.$workers?.scriptVersion?.id!==identity.workerVersion || event.$workers?.scriptName!==identity.workerName
      || correlated.length!==1 || correlated[0].$workers?.outcome!=="ok" || correlated.some((row)=>row.$workers?.truncated)) {
      unavailableReasons.push(`runtime-uncorrelated-or-failed:${summary.sampleId}`);continue;
    }
    samples.push({summary,requestId,cpuTimeMs:correlated[0].$workers!.cpuTimeMs!,outcome:"ok"});
  }
  unavailableReasons.push(...coverage(samples));
  const body={schemaVersion:1 as const,source:"cloudflare-workers-raw-invocation-logs" as const,identity,collectedAt,window,versionBindings,
    complete:unavailableReasons.length===0,unavailableReasons,samples:samples.sort((a,b)=>a.summary.sampleId.localeCompare(b.summary.sampleId)),measurements:summarize(samples)};
  const artifact={...body,evidenceHash:await eodHash(body)};
  if(artifact.complete)await validateRuntimeEvidence(artifact,identity);
  return artifact;
}

/** A bounded, read-only collector. A full result page is explicitly incomplete;
 * narrow the time window instead of guessing that the missing page is harmless. */
export async function collectRuntimeEvidence(input:{accountId:string;token:string;identity:RuntimeEvidenceIdentity;from:number;to:number;fetcher?:Fetcher}):Promise<RuntimeEvidence> {
  const {identity}=input;identitySchema.parse(identity);
  if(!/^[a-f0-9]{32}$/i.test(input.accountId)||!input.token)throw new Error("runtime-cloudflare-credentials-invalid");
  if(!Number.isFinite(input.from)||!Number.isFinite(input.to)||input.to<=input.from||input.to-input.from>86_400_000)throw new Error("runtime-invalid-window");
  const fetcher=input.fetcher??fetch,base=`https://api.cloudflare.com/client/v4/accounts/${input.accountId}`;
  const call=async(path:string,body?:unknown):Promise<unknown>=>{
    const response=await fetcher(base+path,{method:body?"POST":"GET",headers:{authorization:`Bearer ${input.token}`,"content-type":"application/json"},
      ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30_000)});
    if(!response.ok)throw new Error(`runtime-cloudflare-http-${response.status}`);
    const data=await response.json() as {success?:boolean;result?:unknown};if(!data.success||!data.result)throw new Error("runtime-cloudflare-response-invalid");return data.result;
  };
  const version=await call(`/workers/scripts/${encodeURIComponent(identity.workerName)}/versions/${identity.workerVersion}`);
  const response=await call("/workers/observability/telemetry/query",{queryId:`eod-runtime-${identity.probeId}`,view:"events",limit:2000,dry:true,
    timeframe:{from:input.from,to:input.to},parameters:{datasets:["cloudflare-workers"],filterCombination:"and",
      filters:[{key:"$metadata.service",operation:"eq",type:"string",value:identity.workerName}]}}) as {events?:{events?:LogEvent[];count?:number}|LogEvent[]};
  const events=Array.isArray(response.events)?response.events:response.events?.events;
  if(!Array.isArray(events))throw new Error("runtime-cloudflare-events-unavailable");
  const count=Array.isArray(response.events)?events.length:response.events?.count;
  return buildRuntimeEvidence(identity,version,events,{from:input.from,to:input.to},events.length<2000 && typeof count==="number" && count===events.length);
}
