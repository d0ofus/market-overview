import { loadOfficialRateFacts, refreshOfficialRateFacts, type OfficialRatesResult } from "./official-rates-service";
import { getUsMarketSessionContext } from "./market-calendar";
import type { Env } from "./types";
import { resolveFetchTimeoutMs } from "./timeout";
import { claimRateProbabilityRefresh, finishRateProbabilityRefresh, loadRateProbabilityState, RateProbabilityError,
  type RateProbabilityState } from "./rate-probability-state";
import {
  loadLatestFomcCommentary,
  loadOrRefreshLatestFomcCommentary,
  type FomcCommentaryItem,
} from "./fomc-commentary-service";

const RATE_PROBABILITY_API_URL = "https://rateprobability.com/api/latest";
const RATE_PROBABILITY_SOURCE_URL = "https://rateprobability.com/fed";
const SNAPSHOT_RETENTION_DAYS = 14;
const SNAPSHOT_FRESH_MS = 60 * 60_000;

type RateProbabilityApiRow = {
  meeting?: string;
  meeting_iso?: string;
  implied_rate_post_meeting?: number;
  prob_move_pct?: number;
  prob_is_cut?: boolean;
  num_moves?: number;
  num_moves_is_cut?: boolean;
  change_bps?: number;
};

type RateProbabilityApiComparisonRow = {
  meeting?: string;
  meeting_iso?: string;
  implied?: number;
};

type RateProbabilityApiComparison = {
  rows?: RateProbabilityApiComparisonRow[];
  used_date?: string;
  effr?: number;
  label?: string;
};

type RateProbabilityApiPayload = {
  today?: {
    as_of?: string;
    "current band"?: string;
    midpoint?: number;
    most_recent_effr?: number;
    assumed_move_bps?: number;
    rows?: RateProbabilityApiRow[];
  };
  ago_1w?: RateProbabilityApiComparison;
  ago_3w?: RateProbabilityApiComparison;
  ago_6w?: RateProbabilityApiComparison;
  ago_10w?: RateProbabilityApiComparison;
};

type StoredFedWatchSnapshotRow = {
  id: string;
  generatedAt: string;
  sourceUrl: string;
  currentTargetRange: string | null;
  dataJson: string;
};

export type FedFundsPathRow = {
  meeting: string;
  meetingIso: string;
  impliedRatePostMeeting: number;
  probMovePct: number;
  probIsCut: boolean;
  numMoves: number;
  numMovesIsCut: boolean;
  changeBps: number;
};

export type FedFundsComparisonSeries = {
  key: "ago_1w" | "ago_3w" | "ago_6w" | "ago_10w";
  label: string;
  usedDate: string | null;
  effr: number | null;
  rows: Array<{
    meeting: string;
    meetingIso: string;
    implied: number;
  }>;
};

export type FedWatchData = {
  generatedAt: string;
  sourceUrl: string;
  asOf: string | null;
  currentBand: string | null;
  midpoint: number | null;
  mostRecentEffr: number | null;
  assumedMoveBps: number | null;
  rows: FedFundsPathRow[];
  comparisons: FedFundsComparisonSeries[];
  fomcCommentary: FomcCommentaryItem[];
};

export type {
  FomcCommentaryCitationSource,
  FomcCommentaryEventType,
  FomcCommentaryItem,
  FomcCommentarySourceMode,
} from "./fomc-commentary-service";

export type FedWatchResponse = Partial<OfficialRatesResult> & {
  probabilitySource?: RateProbabilityState & { asOf: string | null; expiredMeetings: number };
  fomcCommentary?: FomcCommentaryItem[];
  status: "ok" | "stale" | "unavailable";
  warning: string | null;
  data: FedWatchData | null;
};

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function validDate(value:string):boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;
}
function sourceDate(value:unknown):string|null {
  const date=typeof value==="string" ? value.match(/^\d{4}-\d{2}-\d{2}(?=$|[T ])/u)?.[0] : null;
  return date && validDate(date) ? date : null;
}
/** Each quoted meeting ceases to be an upcoming expectation at its scheduled
 * 14:00 New York decision. Dates are compared in New York through DST. */
export function applicableFedWatchData(data:FedWatchData,now=new Date()):FedWatchData|null {
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",hourCycle:"h23"}).formatToParts(now);
  const part=(type:string)=>parts.find(row=>row.type===type)?.value ?? "";
  const date=`${part("year")}-${part("month")}-${part("day")}`,hour=Number(part("hour"));
  const rows=data.rows.filter(row=>validDate(row.meetingIso) && (row.meetingIso>date || (row.meetingIso===date && hour<14)));
  if(!rows.length) return null;
  const meetings=new Set(rows.map(row=>row.meetingIso));
  return {...data,rows,comparisons:data.comparisons.map(series=>({...series,rows:series.rows.filter(row=>meetings.has(row.meetingIso))}))
    .filter(series=>series.rows.length>0)};
}

function parseTodayRow(row: RateProbabilityApiRow): FedFundsPathRow | null {
  if(!row || typeof row!=="object") return null;
  const meeting = String(row.meeting ?? "").trim();
  const meetingIso = String(row.meeting_iso ?? "").trim();
  const impliedRatePostMeeting = asNumber(row.implied_rate_post_meeting);
  const probMovePct = asNumber(row.prob_move_pct);
  const numMoves = asNumber(row.num_moves);
  const changeBps = asNumber(row.change_bps);
  if (!meeting || !validDate(meetingIso) || impliedRatePostMeeting == null || probMovePct == null || probMovePct < 0 || probMovePct > 100 || numMoves == null || numMoves < 0 || changeBps == null
    || typeof row.prob_is_cut!=="boolean" || typeof row.num_moves_is_cut!=="boolean") {
    return null;
  }
  return {
    meeting,
    meetingIso,
    impliedRatePostMeeting,
    probMovePct,
    probIsCut: row.prob_is_cut === true,
    numMoves,
    numMovesIsCut: row.num_moves_is_cut === true,
    changeBps,
  };
}

function parseComparisonRows(rows: RateProbabilityApiComparisonRow[] | undefined): FedFundsComparisonSeries["rows"] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      if(!row || typeof row!=="object") return null;
      const meeting = String(row.meeting ?? "").trim();
      const meetingIso = String(row.meeting_iso ?? "").trim();
      const implied = asNumber(row.implied);
      if (!meeting || !validDate(meetingIso) || implied == null) return null;
      return { meeting, meetingIso, implied };
    })
    .filter((value): value is FedFundsComparisonSeries["rows"][number] => Boolean(value));
}

function normalizeComparison(
  key: FedFundsComparisonSeries["key"],
  comparison: RateProbabilityApiComparison | undefined,
): FedFundsComparisonSeries | null {
  const rows = parseComparisonRows(comparison?.rows);
  if (rows.length === 0 || rows.length!==comparison?.rows?.length || new Set(rows.map(row=>row.meetingIso)).size!==rows.length
    || !sourceDate(comparison?.used_date)) return null;
  return {
    key,
    label: String(comparison?.label ?? key).trim(),
    usedDate: typeof comparison?.used_date === "string" ? comparison.used_date : null,
    effr: asNumber(comparison?.effr),
    rows,
  };
}

export function normalizeRateProbabilityPayload(
  payload: RateProbabilityApiPayload,
  generatedAt = new Date().toISOString(),
): FedWatchData | null {
  const today = payload?.today;
  const asOf=sourceDate(today?.as_of);
  if (!asOf || !Array.isArray(today?.rows) || asOf>generatedAt.slice(0,10)) return null;
  const rows = (today?.rows ?? [])
    .map((row) => parseTodayRow(row))
    .filter((value): value is FedFundsPathRow => Boolean(value))
    .sort((a, b) => a.meetingIso.localeCompare(b.meetingIso));
  if (rows.length === 0 || rows.length!==today.rows.length || new Set(rows.map(row=>row.meetingIso)).size!==rows.length) return null;

  const comparisons = [
    normalizeComparison("ago_1w", payload.ago_1w),
    normalizeComparison("ago_3w", payload.ago_3w),
    normalizeComparison("ago_6w", payload.ago_6w),
    normalizeComparison("ago_10w", payload.ago_10w),
  ].filter((value): value is FedFundsComparisonSeries => {
    const used=value ? sourceDate(value.usedDate) : null;
    return Boolean(value && used && used<=asOf);
  });

  return {
    generatedAt,
    sourceUrl: RATE_PROBABILITY_SOURCE_URL,
    asOf: typeof today?.as_of === "string" ? today.as_of : null,
    currentBand: typeof today?.["current band"] === "string" ? today["current band"] : null,
    midpoint: asNumber(today?.midpoint),
    mostRecentEffr: asNumber(today?.most_recent_effr),
    assumedMoveBps: asNumber(today?.assumed_move_bps),
    rows,
    comparisons,
    fomcCommentary: [],
  };
}

async function fetchLiveFedFundsData(env: Env): Promise<FedWatchData> {
  const timeoutMs = resolveFetchTimeoutMs(env.FEDWATCH_TIMEOUT_MS, 5_000, 5_000);
  for(let attempt=0;attempt<2;attempt++) {
    try {
      const response=await fetch(RATE_PROBABILITY_API_URL,{headers:{"User-Agent":"market-command-centre/1.0",Accept:"application/json"},signal:AbortSignal.timeout(timeoutMs)});
      if(!response.ok) {
        const retry=response.headers.get("Retry-After"),seconds=retry && /^\d+$/.test(retry) ? Number(retry) : NaN;
        const retryMs=Number.isFinite(seconds) ? seconds*1000 : retry ? Date.parse(retry)-Date.now() : 0;
        await response.body?.cancel().catch(()=>undefined);
        throw new RateProbabilityError(`rateprobability-http-${response.status}`,[500,502,503,504].includes(response.status),
          [401,403].includes(response.status) ? 24*3_600_000 : response.status===429 ? Math.min(24*3_600_000,Math.max(3_600_000,Number.isFinite(retryMs) ? retryMs : 0)) : 0);
      }
      if(Number(response.headers.get("Content-Length") ?? 0)>1_000_000) {
        await response.body?.cancel().catch(()=>undefined);
        throw new RateProbabilityError("rateprobability-payload-too-large");
      }
      const text=await response.text();
      if(new TextEncoder().encode(text).length>1_000_000) throw new RateProbabilityError("rateprobability-payload-too-large");
      let payload:RateProbabilityApiPayload;
      try {payload=JSON.parse(text) as RateProbabilityApiPayload;} catch {throw new RateProbabilityError("rateprobability-invalid-payload");}
      const parsed=normalizeRateProbabilityPayload(payload,new Date().toISOString());
      if(!parsed || !applicableFedWatchData(parsed)) throw new RateProbabilityError("rateprobability-no-applicable-meetings");
      return parsed;
    } catch(error) {
      const failure=error instanceof RateProbabilityError ? error : new RateProbabilityError("rateprobability-timeout-or-network",true);
      if(!failure.retryable || attempt===1) throw failure;
      await new Promise(resolve=>setTimeout(resolve,500));
    }
  }
  throw new RateProbabilityError("rateprobability-unavailable");
}

function parseStoredData(raw: string): FedWatchData | null {
  try {
    const parsed = JSON.parse(raw) as Partial<FedWatchData> | null;
    if(!parsed || !Array.isArray(parsed.rows) || !sourceDate(parsed.asOf) || !Array.isArray(parsed.comparisons)) return null;
    const valid=normalizeRateProbabilityPayload({today:{as_of:parsed.asOf!,"current band":parsed.currentBand ?? undefined,
      midpoint:parsed.midpoint ?? undefined,most_recent_effr:parsed.mostRecentEffr ?? undefined,assumed_move_bps:parsed.assumedMoveBps ?? undefined,
      rows:parsed.rows.map(row=>({meeting:row.meeting,meeting_iso:row.meetingIso,implied_rate_post_meeting:row.impliedRatePostMeeting,
        prob_move_pct:row.probMovePct,prob_is_cut:row.probIsCut,num_moves:row.numMoves,num_moves_is_cut:row.numMovesIsCut,change_bps:row.changeBps}))}},parsed.generatedAt);
    if(!valid) return null;
    return {...valid,comparisons:parsed.comparisons.flatMap(series=>{
      const comparison=normalizeComparison(series.key,{used_date:series.usedDate ?? undefined,label:series.label,effr:series.effr ?? undefined,
        rows:series.rows.map(row=>({meeting:row.meeting,meeting_iso:row.meetingIso,implied:row.implied}))});
      return comparison ? [comparison] : [];
    }),fomcCommentary:Array.isArray(parsed.fomcCommentary) ? parsed.fomcCommentary : []};
  } catch {
    return null;
  }
}

async function loadLatestStoredSnapshot(env: Env): Promise<FedWatchData | null> {
  const row = await env.DB.prepare(
    "SELECT id, generated_at as generatedAt, source_url as sourceUrl, current_target_range as currentTargetRange, data_json as dataJson FROM fedwatch_snapshots ORDER BY generated_at DESC LIMIT 1",
  ).first<StoredFedWatchSnapshotRow>();
  if (!row?.dataJson) return null;
  const parsed = parseStoredData(row.dataJson);
  if (!parsed) return null;
  return {
    ...parsed,
    generatedAt: row.generatedAt ?? parsed.generatedAt,
    sourceUrl: row.sourceUrl ?? parsed.sourceUrl,
    currentBand: row.currentTargetRange ?? parsed.currentBand ?? null,
  };
}

function isSnapshotFresh(generatedAt: string, now = Date.now(), asOf?: string | null): boolean {
  const parsed = Date.parse(generatedAt);
  if (!Number.isFinite(parsed)) return false;
  const sourceDate = asOf?.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  const expected = getUsMarketSessionContext(new Date(now)).latestCompletedSessionDate;
  return now >= parsed && now - parsed < SNAPSHOT_FRESH_MS && (asOf === undefined || Boolean(sourceDate && sourceDate >= expected && sourceDate <= getUsMarketSessionContext(new Date(now)).nyDate));
}

async function persistSnapshot(env: Env, data: FedWatchData, claimToken: string): Promise<void> {
  const result=await env.DB.prepare(
    `INSERT INTO fedwatch_snapshots (id, generated_at, source_url, current_target_range, data_json, created_at)
      SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM provider_symbol_backoff
        WHERE provider_key='rateprobability' AND ticker='FEDFUNDS' AND reason=? AND no_data_until>?) RETURNING id`,
  ).bind(
    crypto.randomUUID(),
    data.generatedAt,
    data.sourceUrl,
    data.currentBand,
    JSON.stringify(data),
    data.generatedAt,
    claimToken,new Date().toISOString(),
  ).all<{id:string}>();
  if(result.results.length!==1) throw new RateProbabilityError("rateprobability-refresh-lease-lost");
}

async function cleanupOldSnapshots(env: Env, retentionDays = SNAPSHOT_RETENTION_DAYS): Promise<void> {
  await env.DB.prepare("DELETE FROM fedwatch_snapshots WHERE generated_at<? AND id<>(SELECT id FROM fedwatch_snapshots ORDER BY generated_at DESC LIMIT 1)")
    .bind(new Date(Date.now()-Math.max(1,retentionDays)*86_400_000).toISOString())
    .run();
}

export async function loadStoredFedWatchSnapshot(env: Env): Promise<FedWatchResponse> {
  const [stored, official, fomcCommentary, source] = await Promise.all([
    loadLatestStoredSnapshot(env),
    loadOfficialRateFacts(env),
    loadLatestFomcCommentary(env, 4).catch(() => []),
    loadRateProbabilityState(env.DB).catch(():RateProbabilityState=>({status:"unavailable",lastAttemptAt:null,lastSuccessAt:null,
      nextAttemptAt:null,failureCount:0,error:"rateprobability-attempt-state-unavailable"})),
  ]);
  const applicable=stored ? applicableFedWatchData(stored) : null;
  const probabilitySource={...source,asOf:stored?.asOf ?? null,expiredMeetings:(stored?.rows.length ?? 0)-(applicable?.rows.length ?? 0)};
  const failure=source.error ? ` Last refresh: ${source.error}; attempted ${source.lastAttemptAt ?? "unknown"}.` : "";
  const retry=source.nextAttemptAt && source.error ? ` Next retry: ${source.nextAttemptAt}.` : "";
  if (!applicable) return {
    status:"unavailable",warning:(stored ? `Probability meeting references from ${stored.asOf} have elapsed; current probabilities are unavailable.`
      : "Market-implied rate probabilities are unavailable; no probabilities are estimated.")+failure+retry,
    data:null,...official,fomcCommentary,probabilitySource,
  };
  const data={...applicable,fomcCommentary},fresh=isSnapshotFresh(data.generatedAt,Date.now(),data.asOf) && !source.error;
  return {
    status:fresh ? "ok" : "stale",
    warning:fresh ? null : `Historical market probabilities as of ${data.asOf}; last fetched ${data.generatedAt}. They are not current expectations.${failure}${retry}`,
    data,...official,fomcCommentary,probabilitySource,
  };
}

export async function getFedWatchSnapshot(env: Env, options?: { force?: boolean }): Promise<FedWatchResponse> {
  const cached = await loadStoredFedWatchSnapshot(env);
  if (!options?.force && cached.status === "ok") return cached;
  // Each source refreshes independently: a blocked probability endpoint cannot hide official facts/FOMC.
  const [official, fomcCommentary] = await Promise.all([
    refreshOfficialRateFacts(env),
    loadOrRefreshLatestFomcCommentary(env, 4).catch(() => cached.fomcCommentary ?? []),
  ]);
  const independent={...cached,...official,fomcCommentary,data:cached.data ? {...cached.data,fomcCommentary} : null};
  if(cached.probabilitySource?.status==="unavailable") return independent;
  let claim:Awaited<ReturnType<typeof claimRateProbabilityRefresh>>;
  try {claim=await claimRateProbabilityRefresh(env.DB);} catch {
    return {...independent,warning:`${cached.warning ?? ""} Probability refresh deferred because attempt state is unavailable.`.trim()};
  }
  if(!claim) return independent;
  try {
    const live = { ...await fetchLiveFedFundsData(env), fomcCommentary };
    const previousDate=sourceDate(cached.probabilitySource?.asOf),liveDate=sourceDate(live.asOf);
    if(previousDate && liveDate && liveDate<previousDate) {
      throw new RateProbabilityError("rateprobability-source-date-regressed");
    }
    await persistSnapshot(env, live,claim.token);
    await finishRateProbabilityRefresh(env.DB,claim,null);
    await cleanupOldSnapshots(env, SNAPSHOT_RETENTION_DAYS).catch(()=>undefined);
    return {...await loadStoredFedWatchSnapshot(env),...official,fomcCommentary};
  } catch (error) {
    const failure=error instanceof RateProbabilityError ? error : new RateProbabilityError("rateprobability-storage-or-refresh-failed");
    await finishRateProbabilityRefresh(env.DB,claim,failure).catch(()=>undefined);
    return {...await loadStoredFedWatchSnapshot(env),...official,fomcCommentary};
  }
}

export async function refreshFedWatchSnapshot(env: Env): Promise<FedWatchResponse> {
  return await getFedWatchSnapshot(env, { force: true });
}

export { isSnapshotFresh };
