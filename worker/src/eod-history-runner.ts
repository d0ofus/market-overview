import { archiveMarketHistoryBars, loadMarketHistory,marketHistoryBarsMateriallyEqual } from "./market-history";
import { EodPriceProvider } from "./eod-price-provider";
import { repairEodSecurity } from "./eod-price-repair";
import { archiveAndPruneMarketHistory, cleanupUnpointedHistoryBlocks, type HistoryMaintenanceCursor } from "./eod-history-maintenance";
import { refreshHistoryMaintenanceEvidence } from "./eod-history-capacity";
import { loadApprovedStorageHotSessions } from "./eod-storage-history-capacity";
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
  const provider=new EodPriceProvider(env);
  const selectionHash=await eodHash(["history-v3",input.sessionDate,input.tickers,historySessions,hotSessions,input.calendarDates,Boolean(input.reconcileHistory)]);
  const checkpoint=await env.OPS_DB!.prepare("SELECT input_hash as hash,payload_json as payload FROM eod_checkpoints WHERE run_id=? AND chunk_key='history:cursor'")
    .bind(input.runId).first<{hash:string;payload:string}>();
  const saved=checkpoint?.hash===selectionHash ? JSON.parse(checkpoint.payload) as {nextTicker?:number;missing?:Record<string,string>;
    pruneCursor?:HistoryMaintenanceCursor|null;pruneFeed?:"sip"|"yahoo-eod";pruneFeedsDone?:Array<"sip"|"yahoo-eod">;pricesDone?:boolean} : {};
  const missing=saved.missing ?? {};
  // A completed traversal with unresolved gaps is a partial attempt, not an
  // immutable success. A retry rechecks retained coverage and fetches only its
  // missing symbols, so a recovered provider can fill previously reported gaps.
  if ((saved.nextTicker ?? 0)>=input.tickers.length && Object.keys(missing).length) {
    saved.nextTicker=0;
    saved.pricesDone=false;
  }
  const start=input.calendarDates.at(-historySessions);
  if (!start) throw new Error("eod-deep-calendar-incomplete");
  const hotStart=input.calendarDates.at(-hotSessions)!;
  const save=async (value:unknown) => env.OPS_DB!.prepare(`INSERT INTO eod_checkpoints(run_id,chunk_key,input_hash,payload_json,updated_at)
    VALUES(?,'history:cursor',?,?,?) ON CONFLICT(run_id,chunk_key) DO UPDATE SET input_hash=excluded.input_hash,payload_json=excluded.payload_json,updated_at=excluded.updated_at`)
    .bind(input.runId,selectionHash,JSON.stringify(value),new Date().toISOString()).run();
  if (!saved.pricesDone) for (let index=saved.nextTicker ?? 0;index<input.tickers.length;index+=10) {
    const tickers=input.tickers.slice(index,index+10);
    await input.progress("deep-history",{nextTicker:index,total:input.tickers.length});
    const pending=await env.MARKET_DATA_DB!.prepare("SELECT ticker FROM eod_adjustment_repairs WHERE feed='sip' AND status='pending' AND ticker IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(tickers)).all<{ticker:string}>();
    for (const row of pending.results) await repairEodSecurity(env,provider,row.ticker,input.sessionDate,hotStart);
    let old=await loadMarketHistory(env,{tickers,feed:"sip",startDate:start,endDate:input.sessionDate});
    const expected=input.calendarDates.slice(-historySessions);
    // A complete row count alone does not establish session or source coverage.
    // Rotate one tenth of the complete universe through a full price recheck each
    // week; missing history always takes priority regardless of the rotation.
    const rotation=Math.floor(Date.parse(`${input.sessionDate}T00:00:00Z`)/(7*86400_000))%10;
    const rotated=input.reconcileHistory ? tickers.filter((_,i) => (index+i)%10===rotation) : [];
    // Recheck the actually retained deep window, without expanding the entire
    // shared catalog to five years. Explicit selected jobs request 1,400 sessions.
    for (const ticker of rotated) await repairEodSecurity(env,provider,ticker,input.sessionDate,hotStart);
    if (rotated.length) {
      old=old.filter((bar) => !rotated.includes(bar.ticker));
      old.push(...await loadMarketHistory(env,{tickers:rotated,feed:"sip",startDate:start,endDate:input.sessionDate}));
    }
    const needs=tickers.filter((ticker) => {
      const dates=new Set(old.filter((bar) => bar.ticker===ticker && bar.sourceProvider==="alpaca" && bar.adjustment==="split").map((bar) => bar.date));
      return expected.some((date) => !dates.has(date));
    });
    for (const ticker of tickers) if (!needs.includes(ticker)) delete missing[ticker];
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
          await repairEodSecurity(env,provider,ticker,input.sessionDate,hotStart);
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
  return {missing,historyStart:start,historySessions,coverageStatus:Object.keys(missing).length ? "partial" as const : "complete" as const};
}
