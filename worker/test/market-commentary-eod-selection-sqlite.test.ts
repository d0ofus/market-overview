import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { createSqliteD1 } from "./helpers/sqlite-d1";
import { loadLatestMarketCommentary } from "../src/market-commentary-service";
import { EOD_REPORT_PUBLICATION_SOURCE,loadFactualBreadthEvidence } from "../src/factual-market-report";
import type { Env } from "../src/types";
import { summarizeRecentDailyCommentary } from "../src/weekly-market-review-service";
const snapshot=vi.hoisted(()=>({load:vi.fn()}));
vi.mock("../src/eod-publication-service",async original=>({...await original<typeof import("../src/eod-publication-service")>(),loadEodOverview:snapshot.load}));

describe("daily commentary selection follows accepted EOD publications",{timeout:30_000},()=>{
  let core:ReturnType<typeof createSqliteD1>,market:ReturnType<typeof createSqliteD1>,env:Env;
  const date="2026-09-10",publication="accepted-overview-2";
  let audit:unknown[];
  beforeEach(async()=>{
    vi.useFakeTimers();vi.setSystemTime("2026-09-11T05:30:00Z");
    core=createSqliteD1();market=createSqliteD1();market.migrate("market-data-migrations");
    core.script(readFileSync(resolve("migrations/0055_market_commentary.sql"),"utf8"));
    core.script(readFileSync(resolve("migrations/0079_market_commentary_schedule_attempts.sql"),"utf8"));
    env={DB:core.db,MARKET_DATA_DB:market.db,EOD_READ_ENABLED:"true",EOD_RUNNER_MODE:"active"} as Env;
    snapshot.load.mockResolvedValue({status:"ready",asOfDate:date,generationId:publication,generatedAt:"2026-09-11T05:00:00Z"});
    const breadth=await loadFactualBreadthEvidence(env,date,publication);
    audit=[{sourceName:"Market Command dashboard snapshot",note:`Overview publication: ${publication}`},
      {sourceName:EOD_REPORT_PUBLICATION_SOURCE,note:breadth.identity}];
  });
  afterEach(()=>{core.dispose();market.dispose();vi.useRealTimers();vi.clearAllMocks();});
  const insert=async(id:string,sessionDate:string,createdAt:string,sourceAudit:unknown[]=[],status="ready")=>{
    await core.db.prepare(`INSERT INTO market_commentary_reports
      (id,session_date,as_of,market_session,market_session_label,data_basis,provider,model,status,report_markdown,
       source_audit_json,error_message,created_at,updated_at) VALUES(?,?,?,'after_hours','EOD','closing','factual','verified',?,?,?,?,?,?)`)
      .bind(id,sessionDate,createdAt,status,`Report ${id}`,JSON.stringify(sourceAudit),status==="failed" ? "Provider timed out" : null,createdAt,createdAt).run();
  };
  it("selects the accepted previous session instead of a later-dated pre-market placeholder",async()=>{
    await insert("placeholder","2026-09-11","2026-09-11T04:11:00Z");
    await insert("accepted",date,"2026-09-11T05:10:00Z",audit);
    const result=await loadLatestMarketCommentary(env);
    expect(result.report?.id).toBe("accepted");expect(result.report?.sessionDate).toBe(date);
    expect(result.latestAttempt?.attemptedAt).toBe("2026-09-11T05:10:00Z");
    expect(result.warning).not.toContain("not yet been updated");
    expect((await loadLatestMarketCommentary({...env,EOD_RUNNER_MODE:"shadow"})).report?.id).toBe("placeholder");
  });
  it("keeps failed attempt visibility separate from the matching accepted report",async()=>{
    await insert("accepted",date,"2026-09-11T05:10:00Z",audit);
    await insert("failed",date,"2026-09-11T05:20:00Z",audit,"failed");
    await insert("placeholder","2026-09-11","2026-09-11T04:11:00Z");
    const result=await loadLatestMarketCommentary(env);
    expect(result.report?.id).toBe("accepted");expect(result.latestAttempt).toMatchObject({status:"failed",attemptedAt:"2026-09-11T05:20:00Z"});
    expect(result.warning).toContain("latest commentary refresh failed");
  });
  it("requires the complete publication provenance and visibly dates an older revision",async()=>{
    const oldAudit=[{sourceName:"Market Command dashboard snapshot",note:"Overview publication: accepted-overview-1"},
      {sourceName:EOD_REPORT_PUBLICATION_SOURCE,note:"old-breadth-identities"}];
    await insert("old",date,"2026-09-11T04:10:00Z",oldAudit);
    const stale=await loadLatestMarketCommentary(env);
    expect(stale.report?.id).toBe("old");expect(stale.warning).toContain("not yet been updated");
    await insert("matching",date,"2026-09-11T05:10:00Z",audit);
    await insert("newer-wrong-breadth",date,"2026-09-11T05:20:00Z",[audit[0],oldAudit[1]]);
    expect((await loadLatestMarketCommentary(env)).report?.id).toBe("matching");
  });
  it("does not promote unverified placeholders when accepted reports or publications are missing",async()=>{
    await insert("placeholder","2026-09-11","2026-09-11T04:11:00Z");
    expect(await loadLatestMarketCommentary(env)).toMatchObject({status:"empty",report:null});
    snapshot.load.mockResolvedValue(null);
    expect(await loadLatestMarketCommentary(env)).toMatchObject({status:"empty",report:null,warning:"Commentary is awaiting an accepted EOD Overview publication."});
  });
  it("uses only the accepted revision once per session in weekly commentary inputs",async()=>{
    await insert("accepted",date,"2026-09-11T05:10:00Z",audit);
    await insert("newer-wrong-breadth",date,"2026-09-11T05:20:00Z",[audit[0],{sourceName:EOD_REPORT_PUBLICATION_SOURCE,note:"obsolete-revision"}]);
    await insert("unverified-other-day","2026-09-09","2026-09-10T04:11:00Z");
    snapshot.load.mockImplementation(async (_env:Env,_config:string,requested?:string)=>requested && requested!==date ? null
      : {status:"ready",asOfDate:date,generationId:publication,generatedAt:"2026-09-11T05:00:00Z"});
    const sources:Parameters<typeof summarizeRecentDailyCommentary>[2]=[],quality:Parameters<typeof summarizeRecentDailyCommentary>[3]=[];
    const result=await summarizeRecentDailyCommentary(env,{weekStart:"2026-09-07",weekEnd:"2026-09-11"} as Parameters<typeof summarizeRecentDailyCommentary>[1],sources,quality);
    expect(result).toContain("Report accepted");
    expect(result).not.toMatch(/newer-wrong-breadth|unverified-other-day/);
    expect(quality).toEqual([{metric:"Recent daily commentary",status:"ok",note:"Loaded 1 recent daily commentary reports."}]);
    expect(sources[0]?.timestamp).toBe("2026-09-11T05:10:00Z");
  });
});
