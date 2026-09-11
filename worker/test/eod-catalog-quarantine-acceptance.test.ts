import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "./helpers/sqlite-d1";
import { buildEodCatalogRow, encodeEodCatalogPayload, EOD_CATALOG_METHODOLOGY_VERSION } from "../src/eod-catalog-service";
import { validateEodCatalogQuarantines, validateEodCatalogQuarantineState } from "../src/eod-catalog-quarantine-validation";
import { computeEodBreadthMetrics, computeEodTickerMetrics, EOD_METRICS_VERSION } from "../src/eod-metrics";
import { EOD_PUBLICATION_SCOPES } from "../src/eod-coordinator";
import { overviewPayload, type FrozenInputs } from "../src/eod-runner";
import { eodHash } from "../src/eod-publication-service";
import { encodeEodPayload } from "../src/eod-publication-codec";
import { verifyStorageAcceptedPublications } from "../src/market-storage-acceptance";
import { assertEodCutover, type EodCutoverEvidence } from "../src/eod-rollout-service";
import { MARKET_HISTORY_REQUIRED_CONSUMERS } from "../src/eod-history-maintenance";
import { createEodD1Database, createEodAdmission, estimateEodQueries, type EodSql } from "../src/eod-d1-rest";
import type { Env } from "../src/types";

vi.mock("../src/eod-rest-request-limiter", () => ({ pacedEodRestFetch: (_account:string,_token:string,fetcher:typeof fetch,input:RequestInfo | URL,init:RequestInit | (()=>RequestInit)) => fetcher(input,typeof init === "function" ? init() : init) }));
const now = new Date("2026-09-11T23:00:00Z"), session = "2026-09-10", runId = `eod:active:${session}:daily`;
const reason = "adjustment-repair-incomplete", revision = "a".repeat(40);
const tickers = ["BNRG", ...Array.from({length:49},(_,i) => `S${String(i).padStart(3,"0")}`)];
const calendar = ["2026-09-01","2026-09-02","2026-09-03","2026-09-04","2026-09-08","2026-09-09",session];
const identity = { id:"market-storage:test",sourceDatabaseId:"10000000-0000-0000-0000-000000000001",
  targetDatabaseId:"10000000-0000-0000-0000-000000000002",historyDatabaseId:"10000000-0000-0000-0000-000000000003",sessionDate:session,codeRevision:revision };
type Json = Record<string,unknown>;

describe("pending adjustment repair analytical acceptance on real schema", {timeout:30_000}, () => {
  let market:ReturnType<typeof createSqliteD1>, ops:ReturnType<typeof createSqliteD1>, env:Env, inputs:FrozenInputs;
  let pages:Map<string,Json>, catalog:ReturnType<typeof encodeEodCatalogPayload>, checkpoints:Json[];
  beforeEach(async () => {
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(now);
    market=createSqliteD1();market.migrate("market-data-migrations");ops=createSqliteD1();ops.migrate("ops-migrations");
    env={DB:market.db,MARKET_DATA_DB:market.db,MARKET_HISTORY_DB:market.db,OPS_DB:ops.db,EOD_RUNNER_MODE:"active"} as Env;
    const config={sections:[{id:"macro",title:"Macro",groups:[{id:"stocks",title:"Stocks",dataType:"market",items:tickers.slice(0,2).map(ticker=>({ticker,enabled:true,displayName:ticker}))}]}]} as FrozenInputs["config"];
    inputs={config,tickers,calendarDates:calendar,methodologyVersion:EOD_METRICS_VERSION,memberships:EOD_PUBLICATION_SCOPES.slice(1).map(scope=>({
      universeId:scope.slice(8),versionId:`v:${scope}`,source:"fixture",sourceType:"official",sourceUrl:null,sourceAsOfDate:session,verifiedAt:`${session}T20:00:00Z`,members:tickers}))};
    const features=new Map(tickers.map(ticker=>[ticker,computeEodTickerMetrics({ticker,targetSession:session,calendarDates:calendar,
      bars:ticker==="BNRG" ? [] : calendar.map((sessionDate,index)=>({ticker,sessionDate,close:100+index,reportedVolume:1000,
        sourceProvider:"alpaca" as const,sourceFeed:"sip",priceBasis:"split" as const,collectedAt:`${session}T21:00:00Z`,reportedVolumeCollectedAt:`${session}T21:00:00Z`}))})]));
    Object.assign(features.get("BNRG")!,{unavailableReason:reason});
    const catalogRows=tickers.map(ticker=>ticker==="BNRG" ? {ticker,sourceRevision:0,unavailableReason:reason as "adjustment-repair-incomplete"}
      : buildEodCatalogRow(ticker,[],0));
    catalog=encodeEodCatalogPayload(session,catalogRows);pages=new Map();
    pages.set("overview:default",overviewPayload(inputs,features,session,{BNRG:reason}) as unknown as Json);
    for(const membership of inputs.memberships) {
      const calculated=computeEodBreadthMetrics({universeId:membership.universeId,targetSession:session,calendarDates:calendar,
        members:tickers.map(ticker=>({ticker})),bars:[],features});
      pages.set(`breadth:${membership.universeId}`,{...calculated,membership:{versionId:membership.versionId}});
    }
    checkpoints=[];
    const signature=await eodHash([EOD_METRICS_VERSION,calendar]);
    for(let i=0;i<2;i++) {
      const chunk=tickers.slice(i*25,(i+1)*25);
      const revisions=chunk.flatMap(ticker=>["sip","yahoo-eod"].map(feed=>({feed,ticker,revision:0}))).sort((a,b)=>`${a.feed}:${a.ticker}`.localeCompare(`${b.feed}:${b.ticker}`));
      const payload={features:chunk.map(ticker=>[ticker,features.get(ticker)]),catalogRows:catalogRows.slice(i*25,(i+1)*25),revisions,errors:i===0 ? {BNRG:reason} : {}};
      checkpoints.push(payload);const encoded=await encodeEodPayload(payload);
      await ops.db.prepare("INSERT INTO eod_checkpoints(run_id,chunk_key,input_hash,payload_json,updated_at) VALUES(?,?,?,?,?)")
        .bind(runId,`features:${i}`,await eodHash([signature,revisions]),JSON.stringify(encoded),`${session}T22:00:00Z`).run();
    }
    await market.db.prepare("INSERT INTO eod_adjustment_repairs(feed,ticker,status,start_date,updated_at) VALUES('sip','BNRG','pending','2025-04-14',?)")
      .bind(`${session}T21:59:00Z`).run();
    for(const [scope,payload] of [...pages, ["history:catalog",catalog] as const]) await store(scope,payload);
    await ops.db.prepare(`INSERT INTO eod_runs(id,session_date,purpose,mode,status,input_json,progress_json,completed_at,completed_input_clock,created_at,updated_at)
      VALUES(?,?,'daily','active','completed',?,?,?,0,?,?)`).bind(runId,session,JSON.stringify(inputs),JSON.stringify({symbols:50,
        published:EOD_PUBLICATION_SCOPES.map(scope=>`pub:${scope}`),catalogPublicationId:"pub:history:catalog"}),now.toISOString(),now.toISOString(),now.toISOString()).run();
    await ops.db.prepare("INSERT INTO eod_usage(usage_date,rows_read,rows_written) VALUES('2026-09-11',1000,100)").run();
    await ops.db.prepare("INSERT INTO eod_account_usage(usage_date,rows_read,rows_written,sampled_at) VALUES('2026-09-11',2000,200,?)").bind(now.toISOString()).run();
  });
  afterEach(()=>{market?.dispose();ops?.dispose();vi.useRealTimers();vi.unstubAllGlobals();});
  async function store(scope:string,payload:unknown) {
    await market.db.prepare(`INSERT INTO eod_publications(id,scope,session_date,revision,input_hash,methodology_version,payload_json,payload_checksum,payload_codec,status,created_at,accepted_at)
      VALUES(?,?,?,1,?,?,?,?,'json','accepted',?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json,payload_checksum=excluded.payload_checksum`)
      .bind(`pub:${scope}`,scope,session,`hash:${scope}`,scope==="history:catalog" ? EOD_CATALOG_METHODOLOGY_VERSION : EOD_METRICS_VERSION,
        JSON.stringify(payload),await eodHash(payload),now.toISOString(),now.toISOString()).run();
    await market.db.prepare("INSERT INTO eod_publication_pointers(scope,publication_id,session_date,published_at) VALUES(?,?,?,?) ON CONFLICT(scope) DO NOTHING")
      .bind(scope,`pub:${scope}`,session,now.toISOString()).run();
  }
  const acceptance=()=>verifyStorageAcceptedPublications({env,identity,runId,tickers,expectedSession:session});
  const strong=()=>validateEodCatalogQuarantines(env,{catalog,runId,frozenInputs:inputs,sessionDate:session,pages});
  function proof():EodCutoverEvidence {
    return {version:1,codeRevision:revision,methodologyVersion:EOD_METRICS_VERSION,measuredAt:now.toISOString(),sessionDate:session,runId,
      sharedTickers:{count:50,processed:50},fullUniverseCounts:inputs.memberships.map(m=>({universeId:m.universeId as EodCutoverEvidence["fullUniverseCounts"][number]["universeId"],memberCount:50,attemptedCount:50,observedCount:49})),
      scopes:EOD_PUBLICATION_SCOPES.map(scope=>({scope,publicationId:`pub:${scope}`,sessionDate:session})),
      measurements:{usageDate:"2026-09-11",eodRowsRead:1000,eodRowsWritten:100,accountRowsRead:2000,accountRowsWritten:200,httpCpuMs:5,coordinatorCpuMs:8,queriesPerInvocation:30,queryDurationMs:20,source:"fixture-only"},
      limits:{httpCpuMs:10,coordinatorCpuMs:10,queriesPerInvocation:50,queryDurationMs:30000},
      capacity:{measuredAt:now.toISOString(),marketDatabaseBytes:50_000_000,priceTableAndIndexBytes:40_000_000,priceRows:100_000,retainedPriceRows:50*270,archiveDatabaseBytes:20_000_000,additionalArchiveBytes:10_000_000},
      readers:{contractVersion:1,checkedAt:now.toISOString(),consumers:[...MARKET_HISTORY_REQUIRED_CONSUMERS],parityPassed:true},retention:{hotSessions:260,sweepHeadroomSessions:10}};
  }
  it("accepts all seven publications and initial active approval while retaining the repair and all denominators",async()=>{
    const before=await market.db.prepare("SELECT * FROM eod_adjustment_repairs").all();
    const result=await acceptance();expect(result.tickerCount).toBe(50);expect(result.scopes).toHaveLength(7);
    await expect(assertEodCutover(env,revision,proof())).resolves.toMatchObject({runId});
    expect((await market.db.prepare("SELECT * FROM eod_adjustment_repairs").all()).results).toEqual(before.results);
    expect((pages.get("breadth:sp500-core")!.metrics as Json).totalUniverseMembers).toBe(50);
    expect((pages.get("breadth:sp500-core")!.metrics as Json).memberCount).toBe(49);
    expect(catalog.rows.find(row=>row[0]==="BNRG")![1]).toBeNull();
  });
  it("supports a Yahoo-only pending fence and rejects a cleared fence or stale Yahoo revision",async()=>{
    await market.db.prepare("UPDATE eod_adjustment_repairs SET feed='yahoo-eod' WHERE ticker='BNRG'").run();
    await expect(acceptance()).resolves.toMatchObject({tickerCount:50});
    await market.db.prepare("INSERT INTO eod_input_revisions(feed,ticker,revision,updated_at) VALUES('yahoo-eod','BNRG',1,?)").bind(now.toISOString()).run();
    await expect(strong()).rejects.toThrow("checkpoint-quarantine-mismatch");
    await market.db.prepare("UPDATE eod_adjustment_repairs SET status='complete' WHERE ticker='BNRG'").run();
    await expect(strong()).rejects.toThrow("pending-state-mismatch");
  });
  it("rejects malformed markers, fake zero history and an included compatibility entry",async()=>{
    const row=catalog.rows.find(row=>row[0]==="BNRG")!;
    for(const malformed of [[...row,reason],[...row.slice(0,10),"provider-error"],[row[0],0,...row.slice(2)]]) {
      await expect(validateEodCatalogQuarantineState(env,{catalog:{...catalog,rows:[malformed,...catalog.rows.slice(1)]},tickers,sessionDate:session})).rejects.toThrow();
    }
    catalog.compatibility!.rows.push(["BNRG",null,null,null]);
    await expect(strong()).rejects.toThrow("compatibility-invalid");
  });
  it("rejects a stale checkpoint, missing reason, non-null checkpoint feature and hidden breadth denominator",async()=>{
    await ops.db.prepare("UPDATE eod_checkpoints SET updated_at=? WHERE run_id=? AND chunk_key='features:0'").bind(`${session}T21:58:00Z`,runId).run();
    await expect(strong()).rejects.toThrow("checkpoint-quarantine-mismatch");
    await ops.db.prepare("UPDATE eod_checkpoints SET updated_at=? WHERE run_id=? AND chunk_key='features:0'").bind(`${session}T22:00:00Z`,runId).run();
    const cp=checkpoints[0];(cp.errors as Json).BNRG="provider-error";
    await ops.db.prepare("UPDATE eod_checkpoints SET payload_json=? WHERE run_id=? AND chunk_key='features:0'").bind(JSON.stringify(await encodeEodPayload(cp)),runId).run();
    await expect(strong()).rejects.toThrow("checkpoint-quarantine-mismatch");
    (cp.errors as Json).BNRG=reason;((cp.features as [string,Json][])[0][1]).price=1;
    await ops.db.prepare("UPDATE eod_checkpoints SET payload_json=? WHERE run_id=? AND chunk_key='features:0'").bind(JSON.stringify(await encodeEodPayload(cp)),runId).run();
    await expect(strong()).rejects.toThrow("checkpoint-quarantine-mismatch");
    ((cp.features as [string,Json][])[0][1]).price=null;
    await ops.db.prepare("UPDATE eod_checkpoints SET payload_json=? WHERE run_id=? AND chunk_key='features:0'").bind(JSON.stringify(await encodeEodPayload(cp)),runId).run();
    (pages.get("breadth:sp500-core")!.metrics as Json).totalUniverseMembers=49;
    await expect(strong()).rejects.toThrow("breadth-quarantine-mismatch");
  });
  it("rejects non-null Overview prices and keeps healthy pending repairs strict",async()=>{
    const row=((pages.get("overview:default")!.sections as {groups:{rows:Json[]}[]}[])[0].groups[0].rows[0]);
    row.quotePrice=1;await expect(strong()).rejects.toThrow("overview-quarantine-mismatch");row.quotePrice=null;
    await market.db.prepare("INSERT INTO eod_adjustment_repairs(feed,ticker,status,start_date,updated_at) VALUES('sip','S000','pending','2025-04-14',?)").bind(now.toISOString()).run();
    await expect(acceptance()).rejects.toThrow("adjustment repair is pending");
    await expect(assertEodCutover(env,revision,proof())).rejects.toThrow("catalog-publication-inputs-changed");
  });
  it("admits actual fixed REST queries with bounded index lookups and settled credits",async()=>{
    const queries:EodSql[]=[];
    const admission=createEodAdmission(ops.db,"quarantine-proof",{now:()=>now});
    const wrap=(storage:ReturnType<typeof createSqliteD1>)=>createEodD1Database({accountId:"a".repeat(32),token:"test-token",
      databaseId:identity.targetDatabaseId,allowedDatabaseIds:[identity.targetDatabaseId],admission,
      fetcher:async(_url,init)=>{
        const body=JSON.parse(String(init?.body)) as EodSql & {batch?:EodSql[]};
        const batch=body.batch ?? [body];queries.push(...batch);
        return Response.json({success:true,result:await storage.db.batch(batch.map(q=>storage.db.prepare(q.sql).bind(...q.params)))});
      }});
    await expect(validateEodCatalogQuarantines({...env,MARKET_DATA_DB:wrap(market),OPS_DB:wrap(ops)},
      {catalog,runId,frozenInputs:inputs,sessionDate:session,pages})).resolves.toHaveProperty("size",1);
    expect(queries).toHaveLength(2);
    for(const query of queries) {
      expect(estimateEodQueries([query])).toEqual({reads:2000,writes:0});
      const db=query.sql.includes("FROM eod_checkpoints") ? ops.db : market.db;
      const plans=await db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).bind(...query.params).all<{detail:string}>();
      const detail=plans.results.map(row=>row.detail).join("\n");
      if(query.sql.includes("FROM eod_checkpoints")) expect(detail).toMatch(/SEARCH eod_checkpoints USING (?:COVERING )?(?:INDEX|PRIMARY KEY)/);
      else {expect(detail).toMatch(/SEARCH r USING (?:COVERING )?(?:INDEX|PRIMARY KEY)/);expect(detail).toMatch(/SEARCH p USING (?:COVERING )?(?:INDEX|PRIMARY KEY)/);}
      expect(detail).not.toMatch(/SCAN (?:eod_checkpoints|r\b|p\b)/);
    }
    await admission.flush();
    expect(await ops.db.prepare("SELECT reserved_reads,reserved_writes FROM eod_usage WHERE usage_date='2026-09-11'").first()).toEqual({reserved_reads:0,reserved_writes:0});
  });
});
