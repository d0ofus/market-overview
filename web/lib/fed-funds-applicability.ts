import type { FedWatchResponse } from "./api";

/** A page left open through a decision must stop displaying that meeting's
 * old probability even before another server response arrives. */
export function applicableFedFundsSnapshot(snapshot: FedWatchResponse, now: number): FedWatchResponse {
  if(!snapshot.data || !Number.isFinite(now)) return snapshot;
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",hourCycle:"h23"}).formatToParts(now);
  const part=(type:string)=>parts.find(row=>row.type===type)?.value ?? "";
  const date=`${part("year")}-${part("month")}-${part("day")}`,hour=Number(part("hour"));
  const rows=snapshot.data.rows.filter(row=>row.meetingIso>date || (row.meetingIso===date && hour<14));
  if(rows.length===snapshot.data.rows.length) return snapshot;
  if(!rows.length) return {...snapshot,status:"unavailable",data:null,
    warning:`Probability meeting references from ${snapshot.data.asOf ?? "the stored source date"} have elapsed; current probabilities are unavailable.`};
  const meetings=new Set(rows.map(row=>row.meetingIso));
  return {...snapshot,data:{...snapshot.data,rows,comparisons:snapshot.data.comparisons.map(series=>({...series,
    rows:series.rows.filter(row=>meetings.has(row.meetingIso))})).filter(series=>series.rows.length>0)}};
}
