import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createEodAdmission, createEodD1Database } from "../src/eod-d1-rest";
import { reconcileEodAccountUsage } from "../src/eod-account-usage";
import { resolveEodBudgetProfile } from "../src/eod-budget-profile";
import { eodDeadline } from "../src/eod-coordinator";
import { loadMarketHistory } from "../src/market-history";
import { loadStorageMigration } from "../src/market-storage-control";
import { assertStorageExecutionRevision } from "../src/market-storage-execution";
import { assertEodCutover } from "../src/eod-rollout-service";
import { EOD_CONFIGURATION_KEY, eodConfigurationRecordSchema } from "../src/eod-recovery-status";
import { assertListingSourceUrl, listingEvidenceImportSchema, registerListingEvidence, validateListingOperatorRevision, observeBrtmListingIdentity } from "../src/eod-listing-evidence";
import type { Env } from "../src/types";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const required = (name:string) => { const value=process.env[name]?.trim();if(!value)throw new Error("eod-listing-evidence-setting-missing");return value; };
const command = (args:string[]) => execFileSync("git",args,{cwd:root,encoding:"utf8",windowsHide:true,stdio:["ignore","pipe","pipe"],timeout:15_000}).trim();
async function documentText(url:string,symbol:string):Promise<string> {
  const userAgent=required("EOD_LISTING_USER_AGENT");
  if(!/@/.test(userAgent) || userAgent.length>200)throw new Error("eod-listing-evidence-contact-user-agent-required");
  assertListingSourceUrl(url,symbol);
  const response=await fetch(url,{redirect:"error",headers:{"User-Agent":userAgent,Accept:"text/html,text/plain"},signal:AbortSignal.timeout(30_000)});
  if(!response.ok || !/text\/(?:html|plain)/i.test(response.headers.get("content-type") ?? ""))throw new Error("eod-listing-evidence-source-fetch-unavailable");
  const reader=response.body?.getReader();if(!reader)throw new Error("eod-listing-evidence-source-body-missing");
  const decoder=new TextDecoder();let size=0,text="";
  try { while(true) {const next=await reader.read();if(next.done)break;size+=next.value.byteLength;
    if(size>2_000_000)throw new Error("eod-listing-evidence-document-too-large");text+=decoder.decode(next.value,{stream:true});}
    return text+decoder.decode();
  } finally {await reader.cancel().catch(()=>undefined);}
}
async function main():Promise<void> {
  if(process.env.EOD_LISTING_IMPORT_APPROVED!=="true")throw new Error("eod-listing-evidence-operator-approval-required");
  const candidate=listingEvidenceImportSchema.parse(JSON.parse(readFileSync(resolve(root,required("EOD_LISTING_IMPORT_PATH")),"utf8")));
  const mode=required("EOD_LISTING_IMPORT_MODE");
  if(!["future-session","reconstruct"].includes(mode))throw new Error("eod-listing-evidence-import-mode-invalid");
  const revision=required("EOD_CODE_REVISION");
  const checkoutRevision=command(["rev-parse","HEAD"]);
  const repository=process.env.EOD_GITHUB_REPOSITORY ?? "d0ofus/market-overview";
  if(!/^[\w.-]+\/[\w.-]+$/.test(repository))throw new Error("eod-listing-evidence-github-identity-invalid");
  const assertCheckout=()=>{if(!/^[a-f0-9]{40}$/.test(revision)||command(["rev-parse","HEAD"])!==checkoutRevision
    ||command(["branch","--show-current"])!=="main"||command(["status","--porcelain"]))throw new Error("eod-listing-evidence-clean-pinned-main-required");};
  assertCheckout();
  const assertGithub=()=>{const main=execFileSync("gh",["api",`repos/${repository}/git/ref/heads/main`,"--jq",".object.sha"],
    {cwd:root,encoding:"utf8",windowsHide:true,stdio:["ignore","pipe","pipe"],timeout:20_000}).trim();
    if(main!==checkoutRevision)throw new Error("eod-listing-evidence-github-main-mismatch");};
  assertGithub();
  const accountId=required("CLOUDFLARE_ACCOUNT_ID"),token=required("CLOUDFLARE_EOD_D1_TOKEN");
  const coreId=required("EOD_CORE_DATABASE_ID"),marketId=required("EOD_MARKET_DATABASE_ID"),historyId=required("EOD_HISTORY_DATABASE_ID"),opsId=required("EOD_OPS_DATABASE_ID");
  const allowedDatabaseIds=[coreId,marketId,historyId,opsId];
  if(new Set(allowedDatabaseIds).size!==4)throw new Error("eod-listing-evidence-database-identity-invalid");
  const rawOps=createEodD1Database({accountId,token,databaseId:opsId,allowedDatabaseIds});
  const profile=resolveEodBudgetProfile(process.env.EOD_BUDGET_PROFILE);
  const admission=createEodAdmission(rawOps,`listing-registration:${revision}`,{profile,writeCredit:128,
    reconcileAccountUsage:()=>reconcileEodAccountUsage({accountId,token:process.env.CLOUDFLARE_EOD_ANALYTICS_TOKEN||token,ops:rawOps,profile})});
  const db=(databaseId:string)=>createEodD1Database({accountId,token,databaseId,allowedDatabaseIds,admission});
  const env={DB:db(coreId),MARKET_DATA_DB:db(marketId),MARKET_HISTORY_DB:db(historyId),OPS_DB:db(opsId),EOD_RUNNER_MODE:"active",EOD_BUDGET_PROFILE:profile.name} as Env;
  try {
    const migration=await loadStorageMigration(env.OPS_DB!,required("EOD_STORAGE_MIGRATION_ID"));
    if(!migration || migration.target_database_id!==marketId || migration.history_database_id!==historyId
      || !["completed","bootstrap"].includes(migration.status==="completed" ? "completed" : migration.stage)
      || (mode==="reconstruct" && migration.status!=="completed"))throw new Error("eod-listing-evidence-migration-identity-invalid");
    const assertApproval=async()=>{
      let isAncestor=checkoutRevision===revision;
      if(!isAncestor){try{command(["merge-base","--is-ancestor",revision,checkoutRevision]);isAncestor=true;}catch{/* rejected below */}}
      const changedFiles=checkoutRevision===revision ? [] : command(["diff","--name-only",revision,checkoutRevision]).split(/\r?\n/).filter(Boolean);
      validateListingOperatorRevision({actualRevision:checkoutRevision,approvedRevision:revision,remoteMainRevision:checkoutRevision,
        production:migration.status==="completed",isAncestor,changedFiles});
      if(migration.status!=="completed") await assertStorageExecutionRevision(env.OPS_DB!,migration,revision);
      else {
        await assertEodCutover(env,revision);
        const stored=await env.OPS_DB!.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?")
          .bind(EOD_CONFIGURATION_KEY).first<string>("evidence_json");
        const config=eodConfigurationRecordSchema.safeParse(stored ? JSON.parse(stored) : null);
        if(!config.success || config.data.codeRevision!==revision || config.data.migrationId!==migration.id
          || config.data.marketDatabaseId!==marketId)throw new Error("eod-listing-evidence-production-configuration-unverified");
      }
    };
    await assertApproval();
    if(mode==="future-session" && migration.status!=="completed") {
      const prior=await env.OPS_DB!.prepare(`SELECT status,session_date FROM eod_runs WHERE mode='active' AND purpose='daily'
        AND session_date<? ORDER BY session_date DESC LIMIT 1`).bind(candidate.effectiveFromSession).first<{status:string;session_date:string}>();
      if(prior?.status!=="completed")throw new Error("eod-listing-evidence-prior-bootstrap-incomplete");
    }
    const symbol=await env.DB.prepare("SELECT ticker,name,exchange,asset_class,is_active FROM symbols WHERE ticker=?")
      .bind(candidate.security.ticker).first<{ticker:string;name:string;exchange:string|null;asset_class:string|null;is_active:number}>();
    if(symbol && (symbol.is_active!==1 || !symbol.name || !symbol.exchange))throw new Error("eod-listing-evidence-catalog-identity-unavailable");
    if(!symbol && candidate.security.ticker!=="BRTM")throw new Error("eod-listing-evidence-catalog-identity-unavailable");
    const exchangeAliases:Record<string,string>={NASDAQ:"NASDAQ","NASDAQ GLOBAL SELECT":"NASDAQ","NASDAQ GLOBAL MARKET":"NASDAQ",NYSE:"NYSE",ARCA:"NYSE Arca",NYSEARCA:"NYSE Arca","NYSE ARCA":"NYSE Arca",AMEX:"NYSE American","NYSE AMERICAN":"NYSE American"};
    const exchange=symbol ? exchangeAliases[symbol.exchange!.toUpperCase()] ?? symbol.exchange! : "";
    const assetClass=["equity","stock","us_equity"].includes(symbol?.asset_class?.toLowerCase() ?? "") ? "equity" : symbol?.asset_class?.toLowerCase() ?? "";
    const rows=[...await loadMarketHistory(env,{tickers:[candidate.security.ticker],feed:"sip",endDate:candidate.listingDate}),
      ...await loadMarketHistory(env,{tickers:[candidate.security.ticker],feed:"yahoo-eod",endDate:candidate.listingDate})];
    const firstRetainedDate=rows.map(row=>row.date).sort()[0] ?? null;
    const session=await env.MARKET_DATA_DB!.prepare("SELECT close_at FROM market_calendar_sessions WHERE session_date=?")
      .bind(candidate.effectiveFromSession).first<string>("close_at");
    if(!session)throw new Error("eod-listing-evidence-effective-exchange-session-required");
    const document=await documentText(candidate.sourceUrl,candidate.security.ticker);
    let observed=symbol ? {ticker:symbol.ticker,issuerName:symbol.name,exchange,assetClass} : null;
    if(!symbol) {
      const membership=await env.MARKET_DATA_DB!.prepare(`SELECT u.id AS universeId,v.id AS versionId,v.source_type AS sourceType,
        v.source_url AS sourceUrl,v.source_as_of_date AS sourceAsOfDate,COALESCE(v.promoted_at,v.created_at) AS verifiedAt,m.source_ticker AS sourceTicker
        FROM universes u JOIN universe_versions v ON v.id=u.active_version_id JOIN universe_version_members m ON m.version_id=v.id
        WHERE u.id='nasdaq-core' AND v.status='active' AND m.ticker='BRTM'`).first();
      const dates=await env.MARKET_DATA_DB!.prepare("SELECT session_date AS date FROM market_calendar_sessions WHERE session_date<=? ORDER BY session_date DESC LIMIT 30")
        .bind(candidate.effectiveFromSession).all<{date:string}>();
      observed=observeBrtmListingIdentity(candidate,document,membership,dates.results.map(row=>row.date).reverse());
    }
    assertCheckout();assertGithub();await assertApproval();
    const deadlineAt=eodDeadline(candidate.effectiveFromSession,session);
    const nextAttemptAt=new Date(Math.max(Date.now(),Date.parse(deadlineAt)-100*60_000)).toISOString();
    const result=await registerListingEvidence(env.OPS_DB!,candidate,document,{...observed!,firstRetainedDate},checkoutRevision,new Date(),
      mode==="reconstruct" ? {deadlineAt,nextAttemptAt} : undefined);
    console.log(JSON.stringify({status:mode==="reconstruct" ? "reconstruction-queued" : "registered-for-future-inputs",ticker:candidate.security.ticker,
      listingDate:candidate.listingDate,effectiveFromSession:candidate.effectiveFromSession,...result,
      nextAction:mode==="reconstruct" ? "Cloudflare coordinator dispatches the durable reconciliation run; publication completion remains pending."
        : "Create the future session's measured/frozen inputs through the existing population expansion or normal daily coordinator."}));
  } finally {await admission.flush();}
}
main().catch((error:unknown)=>{const message=error instanceof Error ? error.message : "";
  const reason=/^eod-listing-evidence-[a-z-]+$/.test(message) ? message : /budget|quota/i.test(message) ? "eod-listing-evidence-quota-deferred" : "eod-listing-evidence-registration-failed";
  console.error(JSON.stringify({status:"not-completed",reason}));process.exitCode=1;});
