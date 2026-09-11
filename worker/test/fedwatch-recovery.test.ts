import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createSqliteD1 } from "./helpers/sqlite-d1";
import type { Env } from "../src/types";
const sources=vi.hoisted(()=>({loadOfficialRateFacts:vi.fn(),refreshOfficialRateFacts:vi.fn(),
  loadLatestFomcCommentary:vi.fn(),loadOrRefreshLatestFomcCommentary:vi.fn()}));
vi.mock("../src/official-rates-service",()=>sources);
vi.mock("../src/fomc-commentary-service",()=>sources);
import { applicableFedWatchData, loadStoredFedWatchSnapshot, normalizeRateProbabilityPayload, refreshFedWatchSnapshot } from "../src/fedwatch-service";
import { claimRateProbabilityRefresh, finishRateProbabilityRefresh, loadRateProbabilityState, RateProbabilityError } from "../src/rate-probability-state";
const stamp="2026-09-11T04:00:00.000Z";
const row=(date:string)=>({meeting:date,meeting_iso:date,implied_rate_post_meeting:3.5,prob_move_pct:50,
  prob_is_cut:true,num_moves:0.5,num_moves_is_cut:true,change_bps:-12.5});
const payload=()=>({today:{as_of:"2026-09-04",midpoint:3.625,most_recent_effr:3.63,"current band":"3.50 - 3.75",
  rows:[row("2026-09-16"),row("2026-10-28")]}});
describe("durable optional rate probability recovery",{timeout:20_000},()=>{
  let storage:ReturnType<typeof createSqliteD1>,env:Env;
  beforeEach(()=>{
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date(stamp));
    storage=createSqliteD1();storage.script(readFileSync(resolve("migrations/0016_fedwatch_snapshots.sql"),"utf8")+
      readFileSync(resolve("migrations/0078_provider_usage_budget.sql"),"utf8"));env={DB:storage.db} as Env;
    const facts={officialRates:{effectiveDate:"2026-09-09",fetchedAt:stamp,effr:3.63,targetLower:3.5,targetUpper:3.75},officialRatesWarning:null};
    sources.loadOfficialRateFacts.mockResolvedValue(facts);sources.refreshOfficialRateFacts.mockResolvedValue(facts);
    sources.loadLatestFomcCommentary.mockResolvedValue([]);sources.loadOrRefreshLatestFomcCommentary.mockResolvedValue([]);
  });
  afterEach(()=>{storage.dispose();vi.useRealTimers();vi.unstubAllGlobals();vi.clearAllMocks();});
  async function seed() {
    const data=normalizeRateProbabilityPayload(payload(),"2026-09-04T20:00:00.000Z")!;
    await storage.db.prepare("INSERT INTO fedwatch_snapshots(id,generated_at,source_url,data_json) VALUES('last-good',?,?,?)")
      .bind(data.generatedAt,data.sourceUrl,JSON.stringify(data)).run();return data;
  }
  it("persists 403 and a 24-hour cooldown without redating valid September 4/16 last-good pricing",async()=>{
    const previous=await seed(),fetcher=vi.fn(async()=>new Response(null,{status:403}));vi.stubGlobal("fetch",fetcher);
    const response=await refreshFedWatchSnapshot(env);
    expect(response).toMatchObject({status:"stale",data:{asOf:"2026-09-04",generatedAt:previous.generatedAt},
      probabilitySource:{error:"rateprobability-http-403",nextAttemptAt:"2026-09-12T04:00:00.000Z"}});
    expect((await loadStoredFedWatchSnapshot(env)).warning).toContain("rateprobability-http-403");
    await refreshFedWatchSnapshot(env);expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sources.refreshOfficialRateFacts).toHaveBeenCalledTimes(2);
    expect(response.data?.comparisons).toEqual([]);
    vi.setSystemTime(new Date("2026-09-12T04:00:01.000Z"));
    fetcher.mockImplementation(async()=>Response.json(payload()));
    const recovered=await refreshFedWatchSnapshot(env);
    expect(recovered.probabilitySource?.error).toBeNull();expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recovered.status).toBe("stale");expect(recovered.data?.asOf).toBe("2026-09-04");
  });
  it("bounds transient retries and respects 429 Retry-After without immediate retry",async()=>{
    const fetcher=vi.fn(async()=>new Response(null,{status:503}));vi.stubGlobal("fetch",fetcher);
    const failed=await refreshFedWatchSnapshot(env);
    expect(fetcher).toHaveBeenCalledTimes(2);expect(failed.probabilitySource?.failureCount).toBe(1);
    await refreshFedWatchSnapshot(env);expect(fetcher).toHaveBeenCalledTimes(2);
    vi.setSystemTime(new Date("2026-09-11T04:30:01.000Z"));
    fetcher.mockImplementation(async()=>new Response(null,{status:429,headers:{"Retry-After":"7200"}}));
    const limited=await refreshFedWatchSnapshot(env);
    expect(fetcher).toHaveBeenCalledTimes(3);expect(limited.probabilitySource?.nextAttemptAt).toBe("2026-09-11T06:30:01.000Z");
  });
  it("permits one concurrent fetch and recovers a crashed attempt without accepting a stale owner",async()=>{
    const now=new Date(stamp),claims=await Promise.all([claimRateProbabilityRefresh(storage.db,now),claimRateProbabilityRefresh(storage.db,now)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const owner=claims.find(Boolean)!;
    const later=new Date(now.getTime()+120_001),next=await claimRateProbabilityRefresh(storage.db,later);
    expect(next).not.toBeNull();
    await expect(finishRateProbabilityRefresh(storage.db,owner,null,later)).rejects.toThrow("lease-lost");
    await finishRateProbabilityRefresh(storage.db,next!,new RateProbabilityError("rateprobability-http-403",false,86_400_000),later);
    expect((await loadRateProbabilityState(storage.db,later)).error).toBe("rateprobability-http-403");
  });
  it("does not replace last-good pricing with malformed HTTP 200 or source date regression",async()=>{
    await seed();const fetcher=vi.fn(async()=>Response.json({today:{as_of:"2026-09-11",rows:[{meeting:"bad"}]}}));vi.stubGlobal("fetch",fetcher);
    await refreshFedWatchSnapshot(env);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await loadStoredFedWatchSnapshot(env)).data?.asOf).toBe("2026-09-04");
    vi.setSystemTime(new Date("2026-09-11T04:30:01.000Z"));
    fetcher.mockImplementation(async()=>Response.json({...payload(),today:{...payload().today,as_of:"2026-09-03"}}));
    const older=await refreshFedWatchSnapshot(env);
    expect(older.data?.asOf).toBe("2026-09-04");expect(older.probabilitySource?.error).toBe("rateprobability-source-date-regressed");
  });
  it("cannot publish a late provider result after its durable lease was replaced",async()=>{
    const old=await seed();
    vi.stubGlobal("fetch",vi.fn(async()=>{
      vi.setSystemTime(new Date("2026-09-11T04:02:01.000Z"));
      expect(await claimRateProbabilityRefresh(storage.db)).not.toBeNull();
      return Response.json({...payload(),today:{...payload().today,as_of:"2026-09-10"}});
    }));
    const response=await refreshFedWatchSnapshot(env);
    expect(response.data?.generatedAt).toBe(old.generatedAt);
    expect(response.data?.asOf).toBe("2026-09-04");
    expect(await storage.db.prepare("SELECT COUNT(*) AS count FROM fedwatch_snapshots").first<number>("count")).toBe(1);
  });
  it("expires elapsed references and empty curves through decision time and DST without hiding official facts",async()=>{
    const data=await seed();
    expect(applicableFedWatchData(data,new Date("2026-09-16T17:59:59Z"))?.rows).toHaveLength(2);
    expect(applicableFedWatchData(data,new Date("2026-09-16T18:00:00Z"))?.rows.map(item=>item.meetingIso)).toEqual(["2026-10-28"]);
    const winter={...data,rows:[{...data.rows[0],meetingIso:"2026-12-09"}]};
    expect(applicableFedWatchData(winter,new Date("2026-12-09T18:59:59Z"))).not.toBeNull();
    expect(applicableFedWatchData(winter,new Date("2026-12-09T19:00:00Z"))).toBeNull();
    vi.setSystemTime(new Date("2026-10-28T18:00:00Z"));
    const expired=await loadStoredFedWatchSnapshot(env);
    expect(expired).toMatchObject({status:"unavailable",data:null,officialRates:{effr:3.63},probabilitySource:{asOf:"2026-09-04",expiredMeetings:2}});
  });
});
