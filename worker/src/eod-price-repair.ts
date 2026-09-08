import { archiveMarketHistoryBars, loadMarketHistory } from "./market-history";
import { EodPriceProvider, type EodPriceBar } from "./eod-price-provider";
import { writeEodBars } from "./eod-bar-store";
import type { Env } from "./types";
import { ensureMarketCalendarCoverage } from "./market-calendar-cache";

export type EodRevisionChange = {feed:string;ticker:string;count:number};

/** A cross-database repair is fenced until both the archive and hot rows have
 * one adjustment basis. On interruption, the durable fence drives a retry. */
export async function repairEodSecurity(env:Env, provider:EodPriceProvider, ticker:string, target:string, hotStart:string) {
  const token=crypto.randomUUID();
  const acquired=await env.MARKET_DATA_DB!.prepare(`INSERT INTO eod_adjustment_repairs(feed,ticker,status,start_date,updated_at,owner_token)
    VALUES('sip',?,'pending',?,?,?) ON CONFLICT(feed,ticker) DO UPDATE SET status='pending',owner_token=excluded.owner_token,
      start_date=MIN(eod_adjustment_repairs.start_date,excluded.start_date),updated_at=excluded.updated_at
    WHERE eod_adjustment_repairs.status='complete' OR eod_adjustment_repairs.updated_at<=?`)
    .bind(ticker,hotStart,new Date().toISOString(),token,new Date(Date.now()-10*60_000).toISOString()).run();
  if (!acquired.meta.changes) throw new Error("adjustment-repair-already-owned");
  const old = await loadMarketHistory(env,{tickers:[ticker],feed:"sip",endDate:target,allowPendingAdjustmentRepair:true});
  const fence=await env.MARKET_DATA_DB!.prepare("SELECT start_date as startDate FROM eod_adjustment_repairs WHERE feed='sip' AND ticker=?").bind(ticker).first<{startDate:string}>();
  const start=[hotStart,old[0]?.date ?? hotStart,fence?.startDate ?? hotStart].sort()[0];
  await env.MARKET_DATA_DB!.prepare("UPDATE eod_adjustment_repairs SET start_date=? WHERE feed='sip' AND ticker=? AND owner_token=?").bind(start,ticker,token).run();
  await ensureMarketCalendarCoverage(env,target,start);
  const prices = await provider.alpaca([ticker],start,target);
  const calendar=await env.MARKET_DATA_DB!.prepare("SELECT session_date as date FROM market_calendar_sessions WHERE session_date>=? AND session_date<=?")
    .bind(start,target).all<{date:string}>();
  const sessions=new Set(calendar.results.map((row) => row.date));
  if (prices.some((bar) => !sessions.has(bar.date))) throw new Error("alpaca-unexpected-exchange-session");
  const returned = new Set(prices.map((bar) => bar.date));
  if (!returned.has(target) || old.some((bar) => !returned.has(bar.date))) throw new Error("adjustment-repair-incomplete");
  const raw = await provider.alpaca([ticker],start,target,"raw");
  const volumes = new Map(raw.map((bar) => [bar.date,bar]));
  prices.forEach((bar) => {
    bar.reportedVolume=volumes.get(bar.date)?.reportedVolume ?? null;
    bar.reportedVolumeCollectedAt=volumes.get(bar.date)?.reportedVolumeCollectedAt ?? null;
  });
  const revisions:EodRevisionChange[]=[];
  // Write all overlapping archive years, including the hot range: an existing
  // archived copy must not retain the old split basis after the hot copy expires.
  if (env.MARKET_HISTORY_DB) {
    const archived=await archiveMarketHistoryBars(env,prices,{repairFenceToken:token});
    revisions.push(...archived.revisionChanges);
  }
  const hotDates=await env.MARKET_DATA_DB!.prepare("SELECT date FROM alpaca_daily_bars WHERE feed='sip' AND ticker=? AND date<=?")
    .bind(ticker,target).all<{date:string}>();
  const existingHot=new Set(hotDates.results.map((row) => row.date));
  const changed=await writeEodBars(env,env.MARKET_HISTORY_DB ? prices.filter((bar) => bar.date>=hotStart || existingHot.has(bar.date)) : prices);
  changed.forEach((count,key) => revisions.push({feed:"sip",ticker:key,count}));
  const complete=await env.MARKET_DATA_DB!.prepare("UPDATE eod_adjustment_repairs SET status='complete',owner_token=NULL,updated_at=? WHERE feed='sip' AND ticker=? AND owner_token=?")
    .bind(new Date().toISOString(),ticker,token).run();
  if (!complete.meta.changes) throw new Error("adjustment-repair-fence-lost");
  return {bars:prices.filter((bar) => bar.date>=hotStart) as EodPriceBar[],revisions};
}

export async function repairEodYahoo(env:Env,provider:EodPriceProvider,ticker:string,target:string,startDate:string,alpaca:EodPriceBar[]) {
  const token=crypto.randomUUID();
  const acquired=await env.MARKET_DATA_DB!.prepare(`UPDATE eod_adjustment_repairs SET owner_token=?,updated_at=?
    WHERE feed='yahoo-eod' AND ticker=? AND status='pending' AND updated_at<=?`)
    .bind(token,new Date().toISOString(),ticker,new Date(Date.now()-10*60_000).toISOString()).run();
  if (!acquired.meta.changes) throw new Error("adjustment-repair-already-owned");
  const old=await loadMarketHistory(env,{tickers:[ticker],feed:"yahoo-eod",endDate:target,allowPendingAdjustmentRepair:true});
  const start=[startDate,old[0]?.date ?? startDate].sort()[0];
  await ensureMarketCalendarCoverage(env,target,start);
  const bars=await provider.yahoo(ticker,start,target,alpaca);
  const calendar=await env.MARKET_DATA_DB!.prepare("SELECT session_date as date FROM market_calendar_sessions WHERE session_date>=? AND session_date<=?")
    .bind(start,target).all<{date:string}>();
  const sessions=new Set(calendar.results.map((row) => row.date));
  if (bars.some((bar) => !sessions.has(bar.date))) throw new Error("yahoo-unexpected-exchange-session");
  const dates=new Set(bars.map((bar) => bar.date));
  if (!dates.has(target) || old.some((bar) => !dates.has(bar.date))) throw new Error("adjustment-repair-incomplete");
  const archived=await archiveMarketHistoryBars(env,bars,{repairFenceToken:token});
  const complete=await env.MARKET_DATA_DB!.prepare("UPDATE eod_adjustment_repairs SET status='complete',owner_token=NULL,updated_at=? WHERE feed='yahoo-eod' AND ticker=? AND owner_token=?")
    .bind(new Date().toISOString(),ticker,token).run();
  if (!complete.meta.changes) throw new Error("adjustment-repair-fence-lost");
  return {bars,revisions:archived.revisionChanges};
}
