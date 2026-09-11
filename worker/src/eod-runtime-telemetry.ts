import { resolveEodBudgetProfile } from "./eod-budget-profile";
import { isAdminRequestAuthorized } from "./auth";
import { createEodAdmission,type D1Admission,type EodSql } from "./eod-d1-rest";
import { eodHash } from "./eod-publication-service";
import type { Env } from "./types";

export const EOD_RUNTIME_PROBE_LIMIT=24;
export const EOD_RUNTIME_COORDINATOR_PATH="/api/admin/eod/runtime-probe/coordinator";
const idPattern=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export const EOD_RUNTIME_HTTP_PATHS=["/api/dashboard","/api/breadth/dashboard"] as const;
const paths=new Set<string>(EOD_RUNTIME_HTTP_PATHS);
export type RuntimeStats={queries:number;rowsRead:number;rowsWritten:number;maxQueryDurationMs:number;missingMetadata:number;failedQueries:number};
export const emptyRuntimeStats=():RuntimeStats=>({queries:0,rowsRead:0,rowsWritten:0,maxQueryDurationMs:0,missingMetadata:0,failedQueries:0});
export type RuntimeProbeSummary={
  event:"eod-runtime-probe-v1";probeId:string;sampleId:string;category:"http"|"coordinator";route:string;
  codeRevision:string;workerVersion:string;targetDatabaseId:string;eodReadEnabled:boolean;startedAt:string;finishedAt:string;
  outcome:"ok"|"error";complete:boolean;stats:RuntimeStats;cpuSource:"cloudflare-invocation-log-required";
};
function config(env:Env,now=Date.now()) {
  const until=Date.parse(env.EOD_RUNTIME_PROBE_UNTIL ?? "");
  if (!idPattern.test(env.EOD_RUNTIME_PROBE_ID ?? "") || !Number.isFinite(until) || until<=now || until-now>86_400_000
    || !/^[a-f0-9]{40}$/.test(env.EOD_CODE_REVISION ?? "") || !uuid.test(env.EOD_VERSION_METADATA?.id ?? "")
    || !uuid.test(env.EOD_RUNTIME_TARGET_DATABASE_ID ?? "") || !env.OPS_DB) return null;
  return {probeId:env.EOD_RUNTIME_PROBE_ID!,until,codeRevision:env.EOD_CODE_REVISION!,workerVersion:env.EOD_VERSION_METADATA!.id,
    targetDatabaseId:env.EOD_RUNTIME_TARGET_DATABASE_ID!};
}
export function isEodRuntimeHttpProbe(req:Request,env:Env):boolean {
  const value=config(env),url=new URL(req.url),path=url.pathname;
  return Boolean(value && env.ADMIN_SECRET && isAdminRequestAuthorized(req,env)
    && !url.search
    && req.headers.get("x-eod-runtime-probe")===value.probeId
    && ((req.method==="GET" && paths.has(path)) || (req.method==="POST" && path===EOD_RUNTIME_COORDINATOR_PATH)));
}
function observe(stats:RuntimeStats,result:D1Result):void {
  const meta=(result.meta ?? {}) as D1Meta & {timings?:{sql_duration_ms?:number}};
  const duration=meta.timings?.sql_duration_ms ?? meta.duration;
  if (typeof duration!=="number" || !Number.isFinite(duration) || duration<0) stats.missingMetadata++;
  else stats.maxQueryDurationMs=Math.max(stats.maxQueryDurationMs,duration);
  if (!Number.isSafeInteger(meta.rows_read) || !Number.isSafeInteger(meta.rows_written) || meta.rows_read<0 || meta.rows_written<0) stats.missingMetadata++;
  stats.rowsRead+=Number(meta.rows_read ?? 0);stats.rowsWritten+=Number(meta.rows_written ?? 0);
}

/** Observation preserves prepared bindings, first/all semantics and batch
 * statement counts. SQL, parameters and returned records never leave this
 * closure. Unknown D1 methods stop an explicit probe rather than omit usage. */
export function observeRuntimeDatabase(db:D1Database,stats:RuntimeStats,admit?:D1Admission):D1Database {
  type Prepared={native:D1PreparedStatement;query:EodSql};
  const handles=new WeakMap<object,Prepared>();
  const execute=async(native:D1PreparedStatement[],queries:EodSql[],batch:boolean):Promise<D1Result[]>=>{
    const settlement=await admit?.(queries);
    stats.queries+=queries.length;
    try {
      const results=batch ? await db.batch(native) : [await native[0].all()];
      if(results.length!==queries.length || results.some((row)=>!row.success))throw new Error("runtime-probe-incomplete-d1-results");
      results.forEach((row)=>observe(stats,row));
      await settlement?.({rowsRead:results.reduce((sum,row)=>sum+Number(row.meta.rows_read ?? 0),0),
        rowsWritten:results.reduce((sum,row)=>sum+Number(row.meta.rows_written ?? 0),0),sizeAfter:Math.max(0,...results.map((row)=>Number(row.meta.size_after ?? 0)))});
      return results;
    } catch(error) {stats.failedQueries+=queries.length;await settlement?.abandon?.();throw error;}
  };
  const statement=(native:D1PreparedStatement,query:EodSql):D1PreparedStatement=>{
    const value={bind:(...params:unknown[])=>statement(native.bind(...params),{sql:query.sql,params}),
      all:async<T=Record<string,unknown>>()=>(await execute([native],[query],false))[0] as D1Result<T>,
      run:async<T=Record<string,unknown>>()=>(await execute([native],[query],false))[0] as D1Result<T>,
      first:async<T=Record<string,unknown>>(column?:string):Promise<T|null>=>{
        const row=(await execute([native],[query],false))[0].results[0] as Record<string,unknown>|undefined;
        if (!row) return null;
        if (column && !Object.hasOwn(row,column)) throw new Error("runtime-probe-first-column-missing");
        return (column ? row[column] : row) as T;
      },raw:async()=>{throw new Error("runtime-probe-raw-query-unsupported");},
    } as unknown as D1PreparedStatement;
    handles.set(value,{native,query});return value;
  };
  return {prepare:(sql:string)=>statement(db.prepare(sql),{sql,params:[]}),batch:async<T=unknown>(values:D1PreparedStatement[])=>{
    const mapped=values.map((value)=>{const entry=handles.get(value);if(!entry)throw new Error("runtime-probe-batch-binding-mismatch");return entry;});
    return await execute(mapped.map((row)=>row.native),mapped.map((row)=>row.query),true) as D1Result<T>[];
  },exec:async()=>{throw new Error("runtime-probe-exec-unsupported");},dump:async()=>{throw new Error("runtime-probe-dump-unsupported");},
    withSession:()=>{throw new Error("runtime-probe-session-unsupported");}} as unknown as D1Database;
}

/** One durable sample row and one final sanitized log. The final log includes
 * telemetry INSERT and admission settlement statements, whose own duration is
 * necessarily known only after the stored sample has been written. */
export async function runEodRuntimeProbe<T>(env:Env,category:"http"|"coordinator",route:string,action:(env:Env)=>Promise<T>,
  emit:(summary:RuntimeProbeSummary)=>void=(summary)=>console.log(summary)):Promise<T> {
  const value=config(env);if(!value)throw new Error("runtime-probe-disabled-or-invalid");
  const startedAt=new Date().toISOString(),sampleId=crypto.randomUUID(),stats=emptyRuntimeStats();
  const rawOps=observeRuntimeDatabase(env.OPS_DB!,stats);
  const admission=createEodAdmission(rawOps,`runtime:${value.probeId}:${sampleId}`,{profile:resolveEodBudgetProfile(env.EOD_BUDGET_PROFILE),readCredit:50_000,writeCredit:500});
  const wrapped=new Map<D1Database,D1Database>();
  const database=(db:D1Database)=>{let result=wrapped.get(db);if(!result){result=observeRuntimeDatabase(db,stats,admission);wrapped.set(db,result);}return result;};
  const meteredOps=database(env.OPS_DB!),configurationHash=await eodHash(value);
  try {
    const claimed=await meteredOps.prepare(`INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES(?,?,?)
      ON CONFLICT(id) DO UPDATE SET evidence_json=json_set(evidence_json,'$.claimed',json_extract(evidence_json,'$.claimed')+1),updated_at=excluded.updated_at
      WHERE json_extract(evidence_json,'$.configurationHash')=? AND json_extract(evidence_json,'$.claimed')<?`)
      .bind(`eod-runtime-counter:${value.probeId}`,JSON.stringify({claimed:1,configurationHash}),startedAt,configurationHash,EOD_RUNTIME_PROBE_LIMIT).run();
    if (claimed.meta.changes!==1) throw new Error("runtime-probe-sample-limit-or-identity-conflict");
    const target={...env};
    for (const key of ["DB","MARKET_DATA_DB","MARKET_HISTORY_DB","OPS_DB","FUNDAMENTALS_DB","SCANNER_CACHE_DB","PATTERN_DB","PERPLEXITY_CACHE_DB"] as const) {
      const binding=env[key];if(binding)(target as unknown as Record<string,unknown>)[key]=database(binding);
    }
    const sql="INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING";
    const terminal=await admission([{sql,params:[]}]);let terminalUsed=false;
    let outcome:"ok"|"error"="ok",result:T|undefined,failure:unknown;
    try {result=await action(target);if(result instanceof Response && !result.ok)outcome="error";} catch(error) {outcome="error";failure=error;}
    const summary=():RuntimeProbeSummary=>({event:"eod-runtime-probe-v1",probeId:value.probeId,sampleId,category,route,
      codeRevision:value.codeRevision,workerVersion:value.workerVersion,targetDatabaseId:value.targetDatabaseId,
      eodReadEnabled:env.EOD_READ_ENABLED==="true",startedAt,finishedAt:new Date().toISOString(),outcome,
      complete:stats.missingMetadata===0 && stats.failedQueries===0,stats:{...stats},cpuSource:"cloudflare-invocation-log-required"});
    try {
      const persisted=await rawOps.prepare(sql).bind(`eod-runtime:${value.probeId}:${sampleId}`,
        JSON.stringify({...summary(),complete:false,measurementStage:"before-final-control-settlement"}),new Date().toISOString()).run();
      terminalUsed=true;
      await terminal({rowsRead:Number(persisted.meta.rows_read ?? 0),rowsWritten:Number(persisted.meta.rows_written ?? 0),sizeAfter:Number(persisted.meta.size_after ?? 0)});
    } finally {
      if(!terminalUsed)await terminal.abandon?.();
      await admission.flush();
    }
    emit(summary());
    if(failure)throw failure;
    return result as T;
  } finally {await admission.flush();}
}
