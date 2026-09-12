import { archiveMarketHistoryBars, loadMarketHistory,marketHistoryBarsMateriallyEqual } from "./market-history";
import { EodPriceProvider } from "./eod-price-provider";
import { repairEodSecurity } from "./eod-price-repair";
import { archiveAndPruneMarketHistory, cleanupUnpointedHistoryBlocks, type HistoryMaintenanceCursor } from "./eod-history-maintenance";
import { refreshHistoryMaintenanceEvidence } from "./eod-history-capacity";
import { loadApprovedStorageHotSessions, loadStorageHistoryMaintenanceApproval, refreshApprovedStorageHistoryCapacity } from "./eod-storage-history-capacity";
import { admitEodDeepHistory, EOD_DEEP_HISTORY_MAX_OBSERVATIONS, eodDeepHistoryCanFit, loadEodDeepHistoryBudget } from "./eod-deep-history-admission";
import { eodHash } from "./eod-publication-service";
import type { Env } from "./types";

/** Deep history never runs in a page request. Its durable cursor advances only
 * after verified storage; interrupted securities are safe to replay. */
export async function runEodHistoryWork(env:Env,input:{
  runId:string;sessionDate:string;tickers:string[];calendarDates:string[];reconcileHistory?:boolean;
  historySessions?:520|1400;
  hotSessions?:260|90;
  progress:(stage:string,value:unknown)=>Promise<void>;
}) {
  if (!env.MARKET_HISTORY_DB) throw new Error("eod-history-binding-required");
  const historySessions=input.historySessions ?? 520;
  if ((historySessions!==520 && historySessions!==1400) || (historySessions===1400 && input.tickers.length>100)) {
    throw new Error("eod-history-selection-exceeds-bound");
  }
  // The official grid is supplied by the runner. Reject truncated, unordered or
  // future-extended grids before deriving anchors or making provider requests.
  if (input.calendarDates.at(-1)!==input.sessionDate || input.calendarDates.some((date,index) => {
    const time=Date.parse(`${date}T00:00:00Z`);
    return !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(time)
      || new Date(time).toISOString().slice(0,10)!==date || (index>0 && input.calendarDates[index-1]!>=date);
  })) throw new Error("eod-deep-calendar-invalid-grid");
  const hotSessions=input.hotSessions ?? await loadApprovedStorageHotSessions(env) ?? 260;
  if (hotSessions!==260 && hotSessions!==90) throw new Error("eod-history-hot-window-invalid");
  // Deep work may enlarge the archive. Validate the actual approved complete
  // population before providers or writes, even for a selected backfill.
  const capacity=await refreshApprovedStorageHistoryCapacity(env);
  const approved=capacity ? await loadStorageHistoryMaintenanceApproval(env,env.EOD_CODE_REVISION ?? "") : null;
  if (!capacity || !approved || capacity.sample.proofHash!==approved.proofHash) throw new Error("eod-history-capacity-approval-required");
  const approvedTickers=new Set(approved.proof.tickers);
  let budget=await loadEodDeepHistoryBudget(env.OPS_DB!);
  const sorted=[...input.tickers].sort(),after=budget.startAfter===null ? 0 : sorted.findIndex(ticker=>ticker>budget.startAfter!);
  const offset=after<0 ? 0 : after;
  const workTickers=input.reconcileHistory ? [...sorted.slice(offset),...sorted.slice(0,offset)] : input.tickers;
  const provider=new EodPriceProvider(env);
  const selectionHash=await eodHash(["history-v4",input.sessionDate,input.tickers,workTickers,historySessions,hotSessions,input.calendarDates,Boolean(input.reconcileHistory),budget.weekStart]);
  const checkpoint=await env.OPS_DB!.prepare("SELECT input_hash as hash,payload_json as payload FROM eod_checkpoints WHERE run_id=? AND chunk_key='history:cursor'")
    .bind(input.runId).first<{hash:string;payload:string}>();
  const saved=checkpoint?.hash===selectionHash ? JSON.parse(checkpoint.payload) as {nextTicker?:number;missing?:Record<string,string>;
    pruneCursor?:HistoryMaintenanceCursor|null;pruneFeed?:"sip"|"yahoo-eod";pruneFeedsDone?:Array<"sip"|"yahoo-eod">;pricesDone?:boolean} : {};
  const missing=saved.missing ?? {};
  const deferredReasons=new Set(["weekly-history-budget-deferred","history-request-exceeds-weekly-capacity","history-deep-calendar-unavailable","history-population-capacity-required"]);
  const deferred:Record<string,string>=Object.fromEntries(Object.entries(missing).filter(([,reason])=>deferredReasons.has(reason)));
  // A completed traversal with unresolved gaps is a partial attempt, not an
  // immutable success. A retry rechecks retained coverage and fetches only its
  // missing symbols, so a recovered provider can fill previously reported gaps.
  if ((saved.nextTicker ?? 0)>=input.tickers.length && Object.keys(missing).length) {
    saved.nextTicker=0;
    saved.pricesDone=false;
    if (Object.values(missing).some(reason => reason==="history-prune-adjustment-repair-pending")) {
      saved.pruneFeedsDone=[];
      saved.pruneCursor=null;
      saved.pruneFeed=undefined;
    }
  }
  const start=input.calendarDates.at(-historySessions);
  if (!start) throw new Error("eod-deep-calendar-incomplete");
  const hotStart=input.calendarDates.at(-hotSessions)!;
  const save=async (value:unknown) => env.OPS_DB!.prepare(`INSERT INTO eod_checkpoints(run_id,chunk_key,input_hash,payload_json,updated_at)
    VALUES(?,'history:cursor',?,?,?) ON CONFLICT(run_id,chunk_key) DO UPDATE SET input_hash=excluded.input_hash,payload_json=excluded.payload_json,updated_at=excluded.updated_at`)
    .bind(input.runId,selectionHash,JSON.stringify(value),new Date().toISOString()).run();
  const expected=input.calendarDates.slice(-historySessions);
  const admit=async(ticker:string):Promise<boolean> => {
    if (!approvedTickers.has(ticker)) {
      deferred[ticker]="history-population-capacity-required";missing[ticker]=deferred[ticker];return false;
    }
    if (expected.length>budget.maxObservations) {
      deferred[ticker]="history-request-exceeds-weekly-capacity";missing[ticker]=deferred[ticker];return false;
    }
    // An exhausted lower-bound reservation needs no per-security archive read.
    if (!eodDeepHistoryCanFit(budget,ticker,expected)) {
      deferred[ticker]="weekly-history-budget-deferred";missing[ticker]=deferred[ticker];return false;
    }
    const hot=await env.MARKET_DATA_DB!.prepare("SELECT date FROM alpaca_daily_bars WHERE feed='sip' AND ticker=? ORDER BY date LIMIT 1")
      .bind(ticker).first<string>("date");
    const archived=await env.MARKET_HISTORY_DB!.prepare(`SELECT MIN(b.first_date) AS firstDate FROM market_history_block_pointers p
      JOIN market_history_blocks b ON b.id=p.block_id WHERE p.feed='sip' AND p.ticker=?`)
      .bind(ticker).first<string>("firstDate");
    const repairStart=await env.MARKET_DATA_DB!.prepare("SELECT start_date FROM eod_adjustment_repairs WHERE feed='sip' AND ticker=?")
      .bind(ticker).first<string>("start_date");
    const earliest=[start,hot,archived,repairStart].filter((value):value is string=>Boolean(value)).sort()[0];
    let dates=input.calendarDates.filter(date=>date>=earliest);
    if (earliest<input.calendarDates[0]) {
      dates=(await env.MARKET_DATA_DB!.prepare("SELECT session_date AS date FROM market_calendar_sessions WHERE session_date>=? AND session_date<=? ORDER BY session_date LIMIT 2501")
        .bind(earliest,input.sessionDate).all<{date:string}>()).results.map(row=>row.date);
    }
    if (dates.length<=EOD_DEEP_HISTORY_MAX_OBSERVATIONS && (dates[0]!==earliest || dates.at(-1)!==input.sessionDate)) {
      deferred[ticker]="history-deep-calendar-unavailable";missing[ticker]=deferred[ticker];return false;
    }
    const result=await admitEodDeepHistory(env.OPS_DB!,{ticker,dates});budget=result.budget;
    if (!result.admitted) {deferred[ticker]=result.reason;missing[ticker]=result.reason;}
    else delete deferred[ticker];
    return result.admitted;
  };
  if (!saved.pricesDone) for (let index=saved.nextTicker ?? 0;index<workTickers.length;index+=10) {
    const tickers=workTickers.slice(index,index+10);
    const unavailable=new Set(tickers.filter(ticker=>!approvedTickers.has(ticker)));
    for (const ticker of unavailable) {deferred[ticker]="history-population-capacity-required";missing[ticker]=deferred[ticker];}
    // A failed replacement leaves its durable price fence in place. Isolate
    // only this known coverage failure; quota, transport and ownership errors
    // must still stop the attempt with their existing retry policy.
    const repair=async (ticker:string):Promise<boolean> => {
      if (!await admit(ticker)) {unavailable.add(ticker);return false;}
      try { await repairEodSecurity(env,provider,ticker,input.sessionDate,hotStart); return true; }
      catch (error) {
        if (!(error instanceof Error) || error.message!=="adjustment-repair-incomplete") throw error;
        unavailable.add(ticker);
        missing[ticker]="adjustment-repair-incomplete";
        return false;
      }
    };
    await input.progress("deep-history",{nextTicker:index,total:input.tickers.length});
    const pending=await env.MARKET_DATA_DB!.prepare("SELECT ticker FROM eod_adjustment_repairs WHERE feed='sip' AND status='pending' AND ticker IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(tickers.filter(ticker=>!unavailable.has(ticker)))).all<{ticker:string}>();
    for (const row of pending.results) await repair(row.ticker);
    let old=await loadMarketHistory(env,{tickers:tickers.filter(ticker => !unavailable.has(ticker)),feed:"sip",startDate:start,endDate:input.sessionDate});
    // A complete row count alone does not establish session or source coverage.
    // One tenth of the universe is eligible for this week's full price recheck;
    // both those candidates and missing histories share the durable weekly budget.
    const rotation=Math.floor(Date.parse(`${input.sessionDate}T00:00:00Z`)/(7*86400_000))%10;
    const rotated=input.reconcileHistory ? tickers.filter((ticker,i) => !unavailable.has(ticker)
      && !pending.results.some(row => row.ticker===ticker) && (index+i)%10===rotation) : [];
    // Recheck the actually retained deep window, without expanding the entire
    // shared catalog to five years. Explicit selected jobs request 1,400 sessions.
    for (const ticker of rotated) await repair(ticker);
    if (rotated.length) {
      old=old.filter((bar) => !rotated.includes(bar.ticker));
      old.push(...await loadMarketHistory(env,{tickers:rotated.filter(ticker => !unavailable.has(ticker)),feed:"sip",startDate:start,endDate:input.sessionDate}));
    }
    const candidates=tickers.filter((ticker) => {
      if (unavailable.has(ticker)) return false;
      const dates=new Set(old.filter((bar) => bar.ticker===ticker && bar.sourceProvider==="alpaca" && bar.adjustment==="split").map((bar) => bar.date));
      return expected.some((date) => !dates.has(date));
    });
    for (const ticker of tickers) if (!unavailable.has(ticker) && !candidates.includes(ticker)) {delete missing[ticker];delete deferred[ticker];}
    const needs:string[]=[];
    for (const ticker of candidates) if (await admit(ticker)) needs.push(ticker);
    if (needs.length) {
      const prices=await provider.alpaca(needs,start,input.sessionDate);
      if (prices.some((bar) => !expected.includes(bar.date))) throw new Error("alpaca-unexpected-exchange-session");
      const raw=await provider.alpaca(needs,start,input.sessionDate,"raw");
      const rawVolumes=new Map(raw.map((bar) => [`${bar.ticker}:${bar.date}`,bar]));
      const keys=new Map(old.map((bar) => [`${bar.ticker}:${bar.date}`,bar]));
      for (const ticker of needs) {
        const bars=prices.filter((bar) => bar.ticker===ticker);
        bars.forEach((bar) => {
          const volume=rawVolumes.get(`${ticker}:${bar.date}`);
          bar.reportedVolume=volume?.reportedVolume ?? null;
          bar.reportedVolumeCollectedAt=volume?.reportedVolumeCollectedAt ?? null;
        });
        // Delisted/incomplete instruments may have useful older observations
        // despite lacking today's bar. Retain those validated observations and
        // keep the target session explicitly unavailable.
        let available=old.filter((bar) => bar.ticker===ticker && bar.sourceProvider==="alpaca" && bar.adjustment==="split");
        if (bars.some((bar) => {const prior=keys.get(`${ticker}:${bar.date}`);return prior && !marketHistoryBarsMateriallyEqual(prior,bar);})) {
          if (!await repair(ticker)) continue;
          available=await loadMarketHistory(env,{tickers:[ticker],feed:"sip",startDate:start,endDate:input.sessionDate});
        } else if (bars.some((bar) => !keys.has(`${ticker}:${bar.date}`))) {
          await archiveMarketHistoryBars(env,bars);
          available=[...available,...bars];
        }
        const storedDates=new Set(available.map((bar) => bar.date));
        const missingCount=expected.filter((date) => !storedDates.has(date)).length;
        if (!storedDates.has(input.sessionDate)) missing[ticker]=`${provider.symbolErrors.get(ticker) ?? "history-target-session-unavailable"}; ${missingCount} expected sessions unavailable; listing age is not inferred.`;
        else if (missingCount) missing[ticker]=`${missingCount} expected sessions unavailable; listing age is not inferred.`;
        else delete missing[ticker];
      }
    }
    await save({nextTicker:index+tickers.length,missing});
  }
  await save({nextTicker:input.tickers.length,missing,pricesDone:true,pruneCursor:saved.pruneCursor,
    pruneFeed:saved.pruneFeed,pruneFeedsDone:saved.pruneFeedsDone});
  let pruneCursor=saved.pruneCursor;
  if (env.EOD_ARCHIVE_PRUNE_ENABLED==="true" && input.reconcileHistory) {
    const evidence=await refreshHistoryMaintenanceEvidence(env,{tickers:input.tickers,codeRevision:env.EOD_CODE_REVISION ?? ""});
    const feeds=evidence.feeds ?? ["sip"] as const;
    const completedFeeds=new Set(saved.pruneFeedsDone ?? []);
    if ([...completedFeeds].some((feed) => !feeds.includes(feed)) || (saved.pruneFeed && !feeds.includes(saved.pruneFeed))) {
      throw new Error("eod-history-retention-feed-checkpoint-mismatch");
    }
    for (const feed of feeds) {
      if (completedFeeds.has(feed)) continue;
      // Old checkpoints predate Yahoo retention and belong to SIP only.
      pruneCursor=(saved.pruneFeed ?? "sip")===feed ? saved.pruneCursor : null;
      do {
        await input.progress("archive-retention",{feed,cursor:pruneCursor});
        const result=await archiveAndPruneMarketHistory(env,{tickers:input.tickers,endDate:input.sessionDate,
          hotSessions:evidence.hotSessions,capacity:evidence.capacity,readers:evidence.readers,cursor:pruneCursor ?? undefined,maxRows:500,feed});
        pruneCursor=result.cursor;
        for (const ticker of result.deferredRepairs ?? []) missing[ticker]="history-prune-adjustment-repair-pending";
        if (!pruneCursor) completedFeeds.add(feed);
        await save({nextTicker:input.tickers.length,missing,pricesDone:true,pruneCursor,pruneFeed:feed,pruneFeedsDone:[...completedFeeds]});
      } while (pruneCursor);
    }
  }
  if (input.reconcileHistory) {
    const gcState=await env.OPS_DB!.prepare("SELECT evidence_json as value FROM eod_rollout_evidence WHERE id='history-gc-cursor'").first<{value:string}>();
    const cursor=gcState ? (JSON.parse(gcState.value) as {cursor?:string|null}).cursor : null;
    const gc=await cleanupUnpointedHistoryBlocks(env,{maxRows:40,cursor:cursor ?? undefined});
    await env.OPS_DB!.prepare(`INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES('history-gc-cursor',?,?)
      ON CONFLICT(id) DO UPDATE SET evidence_json=excluded.evidence_json,updated_at=excluded.updated_at`)
      .bind(JSON.stringify({cursor:gc.cursor}),new Date().toISOString()).run();
  }
  return {missing,historyStart:start,historySessions,coverageStatus:Object.keys(missing).length ? "partial" as const : "complete" as const,
    deepWork:{weekStart:budget.weekStart,maxSecurities:budget.maxSecurities,maxObservations:budget.maxObservations,
      admittedSecurities:budget.claims.length,chargedObservations:budget.observations,deferred,
      blocked:Object.fromEntries(Object.entries(deferred).filter(([,reason])=>reason!=="weekly-history-budget-deferred")),
      nextAttemptAt:Object.values(deferred).some(reason=>reason==="weekly-history-budget-deferred") ? budget.nextAttemptAt : null}};
}
