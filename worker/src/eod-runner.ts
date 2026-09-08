import { loadConfig } from "./db";
import { refreshBreadthUniverseMemberships, loadEodMemberships } from "./eod";
import { ensureMarketCalendarCoverage } from "./market-calendar-cache";
import { loadMarketHistory, archiveMarketHistoryBars } from "./market-history";
import { EodPriceProvider, yahooWindowMatchesAlpaca, type EodPriceBar } from "./eod-price-provider";
import { computeEodTickerMetrics, computeEodBreadthMetrics, EOD_METRICS_VERSION, type EodMetricBar, type EodTickerMetrics } from "./eod-metrics";
import { eodHash, storeEodPublication } from "./eod-publication-service";
import { EOD_PUBLICATION_SCOPES,eodRunHistorySelection,type EodRun } from "./eod-coordinator";
import type { Env, DashboardConfigPayload, SnapshotReadyResponse } from "./types";
import { zonedParts } from "./refresh-timing";
import { writeEodBars } from "./eod-bar-store";
import { repairEodSecurity, repairEodYahoo, type EodRevisionChange } from "./eod-price-repair";
import { cleanupEodRunState } from "./eod-run-maintenance";
import { runEodHistoryWork } from "./eod-history-runner";
import { ProviderBudgetExceededError } from "./provider-usage";
import { encodeEodPayload,decodeEodPayload } from "./eod-publication-codec";
import { buildEodCatalogRow,encodeEodCatalogPayload,EOD_CATALOG_SCOPE,EOD_CATALOG_METHODOLOGY_VERSION,type EodCatalogRow } from "./eod-catalog-service";

type Membership = {universeId:string;versionId:string;source:string;sourceType:string|null;sourceUrl:string|null;sourceAsOfDate:string|null;verifiedAt:string|null;members:string[]};
type FrozenInputs = {config:DashboardConfigPayload;memberships:Membership[];tickers:string[];calendarDates:string[];methodologyVersion:string};
type FeatureCheckpoint = {features:Array<[string,EodTickerMetrics]>;catalogRows:EodCatalogRow[];revisions:Array<{feed:string;ticker:string;revision:number}>;errors:Record<string,string>};
const metricBar = (bar:EodPriceBar):EodMetricBar => ({
  ticker:bar.ticker,sessionDate:bar.date,close:bar.c,open:bar.o,high:bar.h,low:bar.l,
  reportedVolume:bar.reportedVolume ?? null,sourceProvider:bar.sourceProvider === "yahoo" ? "yahoo" : "alpaca",
  collectedAt:bar.fetchedAt,reportedVolumeCollectedAt:bar.reportedVolumeCollectedAt ?? null,
  sourceFeed:bar.feed,priceBasis:"split",
});
const chunks = <T>(rows:T[],size:number):T[][] => Array.from({length:Math.ceil(rows.length/size)},(_,index) => rows.slice(index*size,(index+1)*size));
const featureIdentity = (metric:EodTickerMetrics|undefined) => {
  if (!metric) return null;
  const {collectedAt:_priceTime,reportedVolumeCollectedAt:_volumeTime,...values}=metric;
  return values;
};

export async function loadEodInputs(env:Env,session:string):Promise<FrozenInputs> {
  const config=await loadConfig(env,"default");
  const db=env.MARKET_DATA_DB!;
  const calendar=await db.prepare("SELECT session_date as date FROM market_calendar_sessions WHERE session_date<=? ORDER BY session_date DESC LIMIT 1600")
    .bind(session).all<{date:string}>();
  const calendarDates=calendar.results.map((row) => row.date).reverse();
  if (calendarDates.length<400 || calendarDates.at(-1)!==session) throw new Error("eod-calendar-incomplete");
  const memberships=await loadEodMemberships(env,session);
  const catalog=await env.DB.prepare(`SELECT ticker FROM symbols WHERE COALESCE(is_active,1)=1
    AND COALESCE(catalog_managed,0)=1 AND lower(COALESCE(asset_class,'')) IN ('equity','stock') ORDER BY ticker`).all<{ticker:string}>();
  const overview=config.sections.flatMap((section) => section.groups.flatMap((group) => group.items.filter((item) => item.enabled).map((item) => item.ticker)));
  const orderedMemberships=[...memberships].sort((a,b) => Number(b.universeId==="sp500-core")-Number(a.universeId==="sp500-core"));
  const tickers=Array.from(new Set([...overview,"SPY",...orderedMemberships.flatMap((row) => row.members),...catalog.results.map((row) => row.ticker)]));
  return {config,memberships,tickers,calendarDates,methodologyVersion:EOD_METRICS_VERSION};
}

async function inputRevisions(env:Env,tickers:string[]) {
  const rows=await env.MARKET_DATA_DB!.prepare("SELECT feed,ticker,revision FROM eod_input_revisions WHERE ticker IN (SELECT value FROM json_each(?)) ORDER BY feed,ticker")
    .bind(JSON.stringify(tickers)).all<{feed:string;ticker:string;revision:number}>();
  const relevant=rows.results.filter((row) => row.feed==="sip" || row.feed==="yahoo-eod");
  for (const ticker of tickers) for (const feed of ["sip","yahoo-eod"]) {
    if (!relevant.some((row) => row.ticker===ticker && row.feed===feed)) relevant.push({ticker,feed,revision:0});
  }
  return relevant.sort((a,b) => `${a.feed}:${a.ticker}`.localeCompare(`${b.feed}:${b.ticker}`));
}

export function overviewPayload(inputs: FrozenInputs, features: Map<string, EodTickerMetrics>, session: string, diagnostics:Record<string,string>={}): SnapshotReadyResponse {
  const items = inputs.config.sections.flatMap((section) => section.groups.flatMap((group) => group.items.filter((item) => item.enabled)));
  const uniqueTickers = Array.from(new Set(items.map((item) => item.ticker)));
  const metricFor = (ticker: string): EodTickerMetrics => {
    const metric = features.get(ticker);
    return metric?.sessionDate === session && metric.methodologyVersion === inputs.methodologyVersion
      ? metric : computeEodTickerMetrics({ ticker, targetSession: session, calendarDates: inputs.calendarDates, bars: [] });
  };
  const available = uniqueTickers.filter((ticker) => metricFor(ticker).price !== null).length;
  if (available === 0) throw new Error("overview-no-verified-prices");
  const partial = uniqueTickers.some((ticker) => {
    const metric = metricFor(ticker);
    return [metric.price, metric.change1d, metric.change5d, metric.change21d, metric.change3m, metric.change6m, metric.ytd,
      metric.pctFrom52wHigh, metric.above20Sma, metric.above50Sma, metric.above200Sma].some((value) => value === null);
  });
  const generatedAt = new Date().toISOString();
  const spy = metricFor("SPY");
  return {
    status: "ready", asOfDate: session, generatedAt,
    providerLabel: "Alpaca SIP split-adjusted daily prices; Yahoo split-adjusted daily fallback. Price returns, not dividend-adjusted total returns.",
    config: inputs.config, expectedAsOfDate: session, servingState: partial ? "degraded" : "ready",
    freshnessStatus: partial ? "partial" : "fresh", freshnessCoveragePct: available / uniqueTickers.length * 100,
    freshnessCurrentCount: available, freshnessEligibleCount: uniqueTickers.length,
    freshnessCriticalMissingTickers: ["SPY", "QQQ", "IWM", "DIA"].filter((ticker) => uniqueTickers.includes(ticker) && metricFor(ticker).price === null),
    freshnessMinBarDate: session, freshnessMaxBarDate: session,
    freshnessWarning: partial ? `Verified EOD prices for ${available}/${uniqueTickers.length} tickers. Missing history-dependent fields remain unavailable; charts retain missing-session gaps.` : null,
    sections: inputs.config.sections.map((section) => ({
      id: section.id, title: section.title, description: section.description,
      groups: section.groups.map((group) => ({
        id: group.id, title: group.title, dataType: group.dataType, rankingWindowDefault: group.rankingWindowDefault,
        showSparkline: group.showSparkline, pinTop10: group.title.startsWith("Sector ETFs") ? false : group.pinTop10, columns: group.columns,
        rows: group.items.filter((item) => item.enabled).map((item) => {
          const m = metricFor(item.ticker);
          const source = m.sourceProvider ? `${m.sourceProvider}:${m.sourceProvider === "alpaca" ? "sip" : "daily"}:split` : null;
          const hasPrice = m.price !== null;
          const dates = m.sparklineDates.slice(-30);
          const ratios = dates.map((date) => {
            const own = m.sparkline[m.sparklineDates.indexOf(date)];
            const base = spy.sparkline[spy.sparklineDates.indexOf(date)];
            return own != null && base != null && base > 0 ? own / base : null;
          });
          const anchor = ratios.find((value): value is number => value !== null && Number.isFinite(value));
          const rs = anchor ? ratios.map((value) => value === null ? null : value / anchor * 100) : null;
          const points = m.sparkline.filter((value): value is number => value !== null && Number.isFinite(value));
          const throughDate = m.sparklineDates.filter((_, index) => m.sparkline[index] !== null).at(-1) ?? null;
          const seriesStatus = points.length < 2 ? "unavailable" as const
            : throughDate !== session ? "stale" as const : points.length !== m.sparkline.length ? "fallback" as const : "fresh" as const;
          const failure=diagnostics[item.ticker]?.slice(0,250);
          const reason = hasPrice ? `Verified ${session} EOD close from ${source}; each populated metric requires its exact session window.`
            : `No verified EOD price for ${session}; no earlier quote is substituted.${failure ? ` Source result: ${failure}.` : ""}`;
          return {
            ticker: item.ticker, displayName: item.displayName, price: m.price, change1d: m.change1d, change1w: m.change1w,
            change5d: m.change5d, change3m: m.change3m, change6m: m.change6m, change21d: m.change21d, ytd: m.ytd,
            pctFrom52wHigh: m.pctFrom52wHigh, above20Sma: m.above20Sma, above50Sma: m.above50Sma, above200Sma: m.above200Sma,
            sparkline: points.length ? m.sparkline : null, sparklineDates: m.sparklineDates,
            relativeStrength30dVsSpy: rs, relativeStrength30dDates: dates,
            barDate: hasPrice ? session : null, barFreshnessStatus: hasPrice ? "fresh" as const : "unavailable" as const,
            barFreshnessReason: reason, quotePrice: m.price, quoteChange1d: m.change1d, quoteSource: hasPrice ? source : null,
            quoteFetchedAt: m.collectedAt, quoteFreshnessStatus: hasPrice ? "fresh" as const : "unavailable" as const, quoteFreshnessReason: reason,
            currentData: {
              sessionDate: session, status: hasPrice ? "fresh" as const : "unavailable" as const, reason,
              quoteSource: hasPrice ? source : null, performanceSource: m.change1d !== null ? source : null,
              smaSource: [m.above20Sma, m.above50Sma, m.above200Sma].some((value) => value !== null) ? source : null,
              fieldSources: { ...m.fieldSources }, providerStatuses: {}, fetchedAt: m.collectedAt,
              tradingViewSymbol: null, tradingViewTime: null, tradingViewLastBarUpdateTime: null, tradingViewLastPriceUpdateTime: null,
              tradingViewUpdateTime: null, tradingViewUpdateMode: null, tradingViewCurrentSession: null,
            },
            historyData: {
              sessionDate: session, status: hasPrice ? "fresh" as const : "unavailable" as const, reason,
              barDate: hasPrice ? session : null, source, seriesThroughDate: throughDate, seriesStatus, seriesSource: source,
              seriesReason: `${points.length}/${m.sparkline.length} plotted sessions; missing sessions remain gaps. Relative strength uses date-aligned ratios to SPY, rebased to the first jointly observed date.`,
            },
            rankKey: group.rankingWindowDefault === "YTD" ? m.ytd : group.rankingWindowDefault === "52W" ? m.pctFrom52wHigh : group.rankingWindowDefault === "1D" ? m.change1d : m.change5d,
            holdings: item.holdings,
          };
        }),
      })),
    })),
  };
}

export async function runEodBatch(env:Env,runId:string,controlDb:D1Database = env.OPS_DB!):Promise<{status:string;published:string[]}> {
  if (!env.MARKET_DATA_DB || !env.OPS_DB || !env.ALPACA_API_KEY || !env.ALPACA_API_SECRET) throw new Error("EOD bindings/credentials are incomplete.");
  const lease=crypto.randomUUID();
  const now=new Date().toISOString();
  // Normal coordination uses the same admitted connection as ingestion. The
  // separate control connection is reserved only for terminal failure reporting.
  const runDb=env.OPS_DB;
  const claim=await runDb.prepare(`UPDATE eod_runs SET status='running',stage='inputs',lease_token=?,lease_until=?,updated_at=?
    WHERE id=? AND status<>'completed' AND (lease_until IS NULL OR lease_until<=?)`)
    .bind(lease,new Date(Date.now()+10*60_000).toISOString(),now,runId,now).run();
  if (!claim.meta.changes) return {status:"not-claimed",published:[]};
  const run=await runDb.prepare("SELECT * FROM eod_runs WHERE id=?").bind(runId).first<EodRun>();
  if (!run) throw new Error("EOD run missing.");
  let leaseLost=false;
  let heartbeatPending=false;
  const heartbeat=setInterval(() => {
    if (heartbeatPending) return;
    heartbeatPending=true;
    void runDb.prepare("UPDATE eod_runs SET lease_until=?,updated_at=? WHERE id=? AND lease_token=?")
      .bind(new Date(Date.now()+10*60_000).toISOString(),new Date().toISOString(),runId,lease).run()
      .then((result) => {if (!result.meta.changes) leaseLost=true;})
      .catch(() => {leaseLost=true;})
      .finally(() => {heartbeatPending=false;});
  },60_000);
  const progress=async (stage:string,value:unknown) => {
    if (leaseLost) throw new Error("eod-lease-lost");
    const result=await runDb.prepare("UPDATE eod_runs SET stage=?,progress_json=?,lease_until=?,updated_at=? WHERE id=? AND lease_token=?")
      .bind(stage,JSON.stringify(value),new Date(Date.now()+10*60_000).toISOString(),new Date().toISOString(),runId,lease).run();
    if (!result.meta.changes) throw new Error("eod-lease-lost");
  };
  const published:string[]=[];
  try {
    await cleanupEodRunState(env,{maxRows:1000});
    await ensureMarketCalendarCoverage(env,run.session_date);
    const session=await env.MARKET_DATA_DB.prepare("SELECT close_at as closeAt FROM market_calendar_sessions WHERE session_date=?")
      .bind(run.session_date).first<{closeAt:string}>();
    const local=zonedParts(new Date(),"America/New_York");
    const [closeHour,closeMinute]=(session?.closeAt ?? "99:99").split(":").map(Number);
    if (!session || run.session_date>local.localDate
      || (run.session_date===local.localDate && local.minutesOfDay<closeHour*60+closeMinute+20)) throw new Error("eod-session-not-complete");
    await refreshBreadthUniverseMemberships(env);
    const frozen=JSON.parse(run.input_json || "{}") as Partial<FrozenInputs>;
    const inputs=frozen.methodologyVersion===EOD_METRICS_VERSION && frozen.tickers?.length && frozen.memberships?.length===5
      ? frozen as FrozenInputs : await loadEodInputs(env,run.session_date);
    if (inputs===frozen) {
      const currentCalendar=await env.MARKET_DATA_DB.prepare("SELECT session_date as date FROM market_calendar_sessions WHERE session_date<=? ORDER BY session_date DESC LIMIT 1600")
        .bind(run.session_date).all<{date:string}>();
      const dates=currentCalendar.results.map((row) => row.date).reverse();
      if (dates.length<400 || dates.at(-1)!==run.session_date) throw new Error("eod-calendar-incomplete");
      // Configuration and constituents remain frozen. An official calendar
      // correction invalidates derived checkpoints, including historical work.
      inputs.calendarDates=dates;
      // A retry may validate the same immutable membership after a source
      // recovers. Refresh that evidence without replacing its constituent set.
      const verified=await loadEodMemberships(env,run.session_date) ?? [];
      inputs.memberships=inputs.memberships.map((membership) => {
        const proof=verified.find((row) => row.versionId===membership.versionId && row.universeId===membership.universeId);
        const oldDate=membership.verifiedAt ?? membership.sourceAsOfDate ?? "";
        const nextDate=proof?.verifiedAt ?? proof?.sourceAsOfDate ?? "";
        if (!proof || nextDate<=oldDate || nextDate.slice(0,10)>run.session_date
          || proof.members.length!==membership.members.length
          || !proof.members.every((ticker) => membership.members.includes(ticker))) return membership;
        return {...membership,source:proof.source,sourceType:proof.sourceType,sourceUrl:proof.sourceUrl,
          sourceAsOfDate:proof.sourceAsOfDate,verifiedAt:proof.verifiedAt};
      });
    }
    await runDb.prepare("UPDATE eod_runs SET input_json=? WHERE id=? AND lease_token=?").bind(JSON.stringify(inputs),runId,lease).run();
    // Membership verification and retrieval timestamps do not change a ticker's
    // calculations. Revision manifests still invalidate corrected price inputs.
    const inputHash=await eodHash([inputs.methodologyVersion,inputs.calendarDates]);
    if (run.purpose==="backfill" || run.purpose==="maintenance") {
      const selection=eodRunHistorySelection(run);
      const result=await runEodHistoryWork(env,{runId,sessionDate:run.session_date,
        tickers:run.purpose==="backfill" ? selection.historyTickers ?? inputs.tickers : inputs.tickers,
        historySessions:run.purpose==="backfill" ? selection.historySessions : 520,
        calendarDates:inputs.calendarDates,progress,reconcileHistory:run.purpose==="maintenance"});
      await runDb.prepare(`UPDATE eod_runs SET status='completed',stage='finished',progress_json=?,lease_until=NULL,
        lease_token=NULL,completed_at=?,updated_at=?,next_attempt_at=NULL,error_code=NULL WHERE id=? AND lease_token=?`)
        .bind(JSON.stringify(result),new Date().toISOString(),new Date().toISOString(),runId,lease).run();
      // Recalculate the already published session after input revision changes.
      const reconcileId=`eod:${run.mode}:${run.session_date}:reconcile`;
      await runDb.prepare(`INSERT INTO eod_runs(id,session_date,purpose,mode,status,stage,created_at,updated_at)
        VALUES(?,?,'reconcile',?,'queued','queued',?,?) ON CONFLICT(session_date,purpose,mode) DO UPDATE SET
        status='queued',input_json='{}',next_attempt_at=NULL,completed_at=NULL WHERE eod_runs.status='completed'`)
        .bind(reconcileId,run.session_date,run.mode,new Date().toISOString(),new Date().toISOString()).run();
      return {status:"completed",published:[]};
    }
    const provider=new EodPriceProvider(env);
    const features=new Map<string,EodTickerMetrics>();
    const catalogRows=new Map<string,EodCatalogRow>();
    const revisions:Array<{feed:string;ticker:string;revision:number}>=[];
    const errors:Record<string,string>={};
    for (const scope of EOD_PUBLICATION_SCOPES) if (scope.startsWith("breadth:")) {
      const universeId=scope.slice("breadth:".length);
      if (!inputs.memberships.some((row) => row.universeId===universeId)) errors[universeId]="membership-unavailable-for-session";
    }
    const start=inputs.calendarDates.at(-260)!;
    const publishedScopes=new Set<string>();
    const publishReadyScopes=async () => {
      if (leaseLost) throw new Error("eod-lease-lost");
      const overviewTickers=Array.from(new Set(["SPY",...inputs.config.sections.flatMap((section) => section.groups.flatMap((group) => group.items.filter((item) => item.enabled).map((item) => item.ticker)))]));
      const overviewRows=overviewTickers.filter((ticker) => ticker!=="SPY" || inputs.config.sections.some((section) => section.groups.some((group) => group.items.some((item) => item.enabled && item.ticker==="SPY"))));
      if (!publishedScopes.has("overview:default") && overviewTickers.every((ticker) => features.has(ticker))
        && overviewRows.some((ticker) => features.get(ticker)?.price!=null)) {
        const overview=overviewPayload(inputs,features,run.session_date,errors);
        if ((overview.freshnessCurrentCount ?? 0)>0) {
          const used=revisions.filter((row) => overviewTickers.includes(row.ticker));
          published.push(await storeEodPublication(env,{scope:"overview:default",sessionDate:run.session_date,
            inputHash:await eodHash([inputs.config,overviewTickers.map((ticker) => featureIdentity(features.get(ticker))),used,
              overviewTickers.filter((ticker) => features.get(ticker)?.price==null).map((ticker) => [ticker,errors[ticker] ?? null])]),
            methodologyVersion:EOD_METRICS_VERSION,payload:overview,promote:run.mode==="active",revisions:used}));
          publishedScopes.add("overview:default");
        }
      }
      for (const membership of inputs.memberships) {
        const scope=`breadth:${membership.universeId}`;
        if (publishedScopes.has(scope) || !membership.members.every((ticker) => features.has(ticker))) continue;
        // Verification and source effective date are separate facts. A fresh
        // verification of an unchanged list must not age the immutable version.
        const verifiedDate=membership.verifiedAt?.slice(0,10) ?? membership.sourceAsOfDate;
        const age=verifiedDate ? inputs.calendarDates.filter((date) => date>verifiedDate).length : Infinity;
        if (age>5 || membership.sourceType==="bundled-fallback") { errors[membership.universeId]="membership-unverified-or-expired"; continue; }
        const result=computeEodBreadthMetrics({universeId:membership.universeId,targetSession:run.session_date,
          calendarDates:inputs.calendarDates,members:membership.members.map((ticker) => ({ticker})),bars:[],features});
        if (!result.publishable) { errors[membership.universeId]="breadth-coverage-below-threshold"; continue; }
        const used=revisions.filter((row) => membership.members.includes(row.ticker));
        const {volumeCollection:_collection,...metricIdentity}=result;
        const scopeHash=await eodHash([membership,metricIdentity,used]);
        const {members:memberTickers,...membershipMetadata}=membership;
        const payload={...result,asOfDate:run.session_date,universeId:membership.universeId,generatedAt:new Date().toISOString(),
          membership:{...membershipMetadata,memberCount:memberTickers.length,degraded:age>0},dataSource:"Alpaca SIP / validated Yahoo fallback",
          provenance:{methodologyVersion:EOD_METRICS_VERSION,inputHash:scopeHash,membershipVersion:membership.versionId}};
        published.push(await storeEodPublication(env,{scope,sessionDate:run.session_date,inputHash:scopeHash,
          methodologyVersion:EOD_METRICS_VERSION,payload,promote:run.mode==="active",revisions:used}));
        publishedScopes.add(scope);
      }
    };
    let yahooAttempts=0;
    for (const [index,tickers] of chunks(inputs.tickers,25).entries()) {
      await progress("prices",{chunk:index,total:Math.ceil(inputs.tickers.length/25),symbols:features.size});
      const existingRevisions=await inputRevisions(env,tickers);
      const key=`features:${index}`;
      const checkpoint=await env.OPS_DB.prepare("SELECT input_hash as hash,payload_json as payload FROM eod_checkpoints WHERE run_id=? AND chunk_key=?")
        .bind(runId,key).first<{hash:string;payload:string}>();
      const signature=await eodHash([inputHash,existingRevisions]);
      if (run.purpose==="daily" && checkpoint?.hash===signature) {
        const stored=JSON.parse(checkpoint.payload) as FeatureCheckpoint & {payloadCodec?:string;payloadBase64?:string};
        const cached=stored.payloadCodec ? await decodeEodPayload({...stored,payload:"{}"}) as FeatureCheckpoint : stored;
        if (cached.catalogRows?.length===tickers.length && tickers.every((ticker) => cached.catalogRows.some((row) => row.ticker===ticker))
          && cached.features.every(([,feature]) => feature.price!==null && feature.change1d!==null && feature.above200Sma!==null)) {
          cached.features.forEach(([ticker,feature]) => features.set(ticker,feature));
          cached.catalogRows.forEach((row) => catalogRows.set(row.ticker,row));
          revisions.push(...cached.revisions); Object.assign(errors,cached.errors);
          await publishReadyScopes(); continue;
        }
      }
      const ownRevisionChanges:EodRevisionChange[]=[];
      const pending=await env.MARKET_DATA_DB.prepare("SELECT ticker FROM eod_adjustment_repairs WHERE feed='sip' AND status='pending' AND ticker IN (SELECT value FROM json_each(?))")
        .bind(JSON.stringify(tickers)).all<{ticker:string}>();
      for (const row of pending.results) {
        const repaired=await repairEodSecurity(env,provider,row.ticker,run.session_date,start);
        ownRevisionChanges.push(...repaired.revisions);
      }
      // Load retained history once for both EOD features and compact catalog
      // counts. Later Worker prefilters never scan/decompress this population.
      let history=await loadMarketHistory(env,{tickers,feed:"sip",endDate:run.session_date}) as EodPriceBar[];
      const yahooPending=await env.MARKET_DATA_DB.prepare("SELECT ticker,start_date as startDate FROM eod_adjustment_repairs WHERE feed='yahoo-eod' AND status='pending' AND ticker IN (SELECT value FROM json_each(?))")
        .bind(JSON.stringify(tickers)).all<{ticker:string;startDate:string}>();
      for (const row of yahooPending.results) {
        const repaired=await repairEodYahoo(env,provider,row.ticker,run.session_date,row.startDate,history.filter((bar) => bar.ticker===row.ticker));
        ownRevisionChanges.push(...repaired.revisions);
      }
      const cachedYahoo=env.MARKET_HISTORY_DB
        ? await loadMarketHistory(env,{tickers,feed:"yahoo-eod",startDate:start,endDate:run.session_date}) as EodPriceBar[] : [];
      let fetchStart=inputs.calendarDates.at(-5)!;
      const existingKeys=new Set(history.filter((bar) => bar.sourceProvider==="alpaca" && bar.adjustment==="split").map((bar) => `${bar.ticker}:${bar.date}`));
      for (const date of inputs.calendarDates.slice(-260)) {
        if (tickers.some((ticker) => !existingKeys.has(`${ticker}:${date}`))) { fetchStart=date; break; }
      }
      const updated:EodPriceBar[]=[];
      try {
        const adjusted=await provider.alpaca(tickers,fetchStart,run.session_date);
        if (adjusted.some((bar) => !inputs.calendarDates.includes(bar.date))) throw new Error("alpaca-unexpected-exchange-session");
        for (const [ticker,error] of provider.symbolErrors) errors[ticker]=error;
        let raw:EodPriceBar[]=[];
        try { raw=await provider.alpaca(tickers,fetchStart,run.session_date,"raw"); }
        catch (error) {
          const message=error instanceof Error ? error.message : "raw-volume-unavailable";
          if (/d1|budget storage|quota|capacity|market-history/.test(message)) throw error;
          errors["reportedVolume"]=message;
        }
        const rawByKey=new Map(raw.map((bar) => [`${bar.ticker}:${bar.date}`,bar]));
        for (const bar of adjusted) {
          const rawBar=rawByKey.get(`${bar.ticker}:${bar.date}`);
          bar.reportedVolume=rawBar?.reportedVolume ?? null;
          bar.reportedVolumeCollectedAt=rawBar?.reportedVolumeCollectedAt ?? null;
        }
        const rebased=new Set(adjusted.filter((bar) => {
          const old=history.find((row) => row.ticker===bar.ticker && row.date===bar.date);
          return old && Math.abs(old.c/bar.c-1)>0.00001;
        }).map((bar) => bar.ticker));
        for (const ticker of rebased) {
          const repaired=await repairEodSecurity(env,provider,ticker,run.session_date,start);
          ownRevisionChanges.push(...repaired.revisions);
          history=history.filter((bar) => bar.ticker!==ticker);
          history.push(...await loadMarketHistory(env,{tickers:[ticker],feed:"sip",endDate:run.session_date}) as EodPriceBar[]);
          updated.push(...repaired.bars);
        }
        updated.push(...adjusted.filter((bar) => !rebased.has(bar.ticker)));
        // Cold bootstrap stores the latest overlap first. Older missing inputs
        // go straight to verified blocks instead of consuming a day's hot writes.
        const overlapStart=inputs.calendarDates.at(-5)!;
        const archiveOnly=env.MARKET_HISTORY_DB ? updated.filter((bar) => bar.date<overlapStart && !existingKeys.has(`${bar.ticker}:${bar.date}`)) : [];
        if (archiveOnly.length) {
          const archived=await archiveMarketHistoryBars(env,archiveOnly);
          ownRevisionChanges.push(...archived.revisionChanges);
        }
        const archiveKeys=new Set(archiveOnly.map((bar) => `${bar.ticker}:${bar.date}`));
        const changed=await writeEodBars(env,updated.filter((bar) => !archiveKeys.has(`${bar.ticker}:${bar.date}`)));
        changed.forEach((count,ticker) => ownRevisionChanges.push({feed:"sip",ticker,count}));
      } catch(error) {
        const message=error instanceof Error ? error.message : "price-fetch-failed";
        if (/d1|budget|quota|capacity|adjustment-repair|market-history/.test(message)) throw error;
        tickers.forEach((ticker) => {errors[ticker]=message;});
      }
      const merged=new Map(history.map((bar) => [`${bar.ticker}:${bar.date}`,bar]));
      updated.forEach((bar) => merged.set(`${bar.ticker}:${bar.date}`,bar));
      const chunkFeatures:Array<[string,EodTickerMetrics]>=[];
      for (const ticker of tickers) {
        const own=[...merged.values()].filter((bar) => bar.ticker===ticker && bar.sourceProvider==="alpaca" && bar.adjustment==="split");
        const cachedFallback=cachedYahoo.filter((bar) => bar.ticker===ticker);
        const validatedFallback=yahooWindowMatchesAlpaca(ticker,cachedFallback,own) ? cachedFallback : [];
        let bars=[...own.map(metricBar),...validatedFallback.map(metricBar)];
        let metric=computeEodTickerMetrics({ticker,targetSession:run.session_date,calendarDates:inputs.calendarDates,bars});
        if ((metric.price===null || metric.change1d===null || metric.above200Sma===null) && yahooAttempts<200) {
          yahooAttempts++;
          try {
            const fallback=await provider.yahoo(ticker,start,run.session_date,own);
            if (fallback.some((bar) => !inputs.calendarDates.includes(bar.date))) throw new Error("yahoo-unexpected-exchange-session");
            // Compact fallback history is separate from the canonical SIP table.
            if (env.MARKET_HISTORY_DB) {
              const archived=await archiveMarketHistoryBars(env,fallback);
              ownRevisionChanges.push(...archived.revisionChanges);
            }
            bars=[...bars.filter((bar) => bar.sourceProvider!=="yahoo"),...fallback.map(metricBar)];
            metric=computeEodTickerMetrics({ticker,targetSession:run.session_date,calendarDates:inputs.calendarDates,bars});
          } catch(error) {
            const message=error instanceof Error ? error.message : "fallback-unavailable";
            if (error instanceof ProviderBudgetExceededError && error.providerKey==="yahoo") yahooAttempts=200;
            else if (/d1|budget|quota|capacity|market-history/.test(message)) throw error;
            errors[ticker]=message;
          }
        }
        features.set(ticker,metric); chunkFeatures.push([ticker,metric]);
      }
      const after=await inputRevisions(env,tickers);
      for (const revision of after) {
        const before=existingRevisions.find((row) => row.feed===revision.feed && row.ticker===revision.ticker)?.revision ?? 0;
        const expected=before+ownRevisionChanges.filter((row) => row.ticker===revision.ticker && row.feed===revision.feed).reduce((sum,row) => sum+row.count,0);
        if (revision.revision!==expected) throw new Error("eod-concurrent-input-correction");
      }
      revisions.push(...after);
      const chunkCatalog=tickers.map((ticker) => buildEodCatalogRow(ticker,[...merged.values()],
        after.find((row) => row.feed==="sip" && row.ticker===ticker)?.revision ?? 0));
      chunkCatalog.forEach((row) => catalogRows.set(row.ticker,row));
      const value:FeatureCheckpoint={features:chunkFeatures,catalogRows:chunkCatalog,revisions:after,errors:Object.fromEntries(tickers.filter((ticker) => errors[ticker]).map((ticker) => [ticker,errors[ticker]]))};
      await env.OPS_DB.prepare(`INSERT INTO eod_checkpoints(run_id,chunk_key,input_hash,payload_json,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(run_id,chunk_key) DO UPDATE SET input_hash=excluded.input_hash,payload_json=excluded.payload_json,updated_at=excluded.updated_at`)
        .bind(runId,key,await eodHash([inputHash,after]),JSON.stringify(await encodeEodPayload(value)),new Date().toISOString()).run();
      await publishReadyScopes();
    }
    const errorSummary={errors:Object.fromEntries(Object.entries(errors).slice(0,100)),errorCount:Object.keys(errors).length};
    await progress("publication",{symbols:features.size,...errorSummary});
    await publishReadyScopes();
    // Capture BEFORE the guarded publication. A subsequent writer must remain
    // visible to the coordinator, including corrections to this same session.
    const inputClock=await env.MARKET_DATA_DB.prepare("SELECT revision FROM eod_input_clock WHERE id='default'").first<{revision:number}>();
    if (!inputClock || !Number.isSafeInteger(inputClock.revision)) throw new Error("eod-input-clock-unavailable");
    if (catalogRows.size!==inputs.tickers.length) throw new Error("eod-catalog-population-incomplete");
    const catalog=encodeEodCatalogPayload(run.session_date,[...catalogRows.values()]);
    const catalogPublicationId=await storeEodPublication(env,{scope:EOD_CATALOG_SCOPE,sessionDate:run.session_date,
      inputHash:await eodHash(catalog),methodologyVersion:EOD_CATALOG_METHODOLOGY_VERSION,payload:catalog,
      promote:run.mode==="active",revisions});
    const complete=published.length===6;
    await runDb.prepare(`UPDATE eod_runs SET status=?,stage='finished',progress_json=?,lease_until=NULL,lease_token=NULL,
      completed_at=?,updated_at=?,next_attempt_at=?,error_code=?,completed_input_clock=? WHERE id=? AND lease_token=?`)
      .bind(complete ? "completed" : "retrying",JSON.stringify({published,catalogPublicationId,...errorSummary,symbols:features.size}),complete ? new Date().toISOString() : null,
        new Date().toISOString(),complete ? null : new Date(Date.now()+15*60_000).toISOString(),
        complete ? null : "incomplete-publication",complete ? inputClock.revision : null,runId,lease).run();
    return {status:complete ? "completed" : "retrying",published};
  } catch(error) {
    const message=error instanceof Error ? error.message : "eod-run-failed";
    const budget=/budget|quota|capacity/i.test(message);
    const next=budget ? new Date(new Date().setUTCHours(24,5,0,0)) : new Date(Date.now()+15*60_000);
    await controlDb.prepare(`UPDATE eod_runs SET status='retrying',error_code=?,error_message=?,lease_until=NULL,
      lease_token=NULL,next_attempt_at=?,updated_at=? WHERE id=? AND lease_token=?`)
      .bind(budget ? "resource-budget" : "runner-error",message.slice(0,500),next.toISOString(),new Date().toISOString(),runId,lease).run();
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}
