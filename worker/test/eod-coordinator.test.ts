import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { checkEodDeadlines, coordinateEod, dispatchEodRun, eodDeadline, eodSlot, eodStatus,
  enqueueEodRun, expectedEodSession, EOD_PUBLICATION_SCOPES, EodHistoryRequestBusyError,
  registerEodRoutes, eodInputCorrectionStatus, scheduleEodInputCorrections, type EodRun } from "../src/eod-coordinator";
import { createSqliteD1 } from "./helpers/sqlite-d1";
import type { Env } from "../src/types";
import { eodEnqueueSchema } from "../src/validation";

vi.mock("../src/market-calendar-cache", () => ({ ensureMarketCalendarCoverage: vi.fn(async () => undefined) }));

describe("EOD calendar scheduling", () => {
  it("uses the session DST offset and the official early close", () => {
    expect(eodDeadline("2026-09-08", "16:00")).toBe("2026-09-08T22:00:00.000Z");
    expect(eodDeadline("2026-01-05", "16:00")).toBe("2026-01-05T23:00:00.000Z");
    expect(eodDeadline("2026-11-27", "13:00")).toBe("2026-11-27T20:00:00.000Z");
    expect(eodSlot(new Date("2026-11-27T18:19:59Z"), { sessionDate: "2026-11-27", closeAt: "13:00" })).toBeNull();
    expect(eodSlot(new Date("2026-11-27T18:20:00Z"), { sessionDate: "2026-11-27", closeAt: "13:00" })).toBe("first");
    expect(eodSlot(new Date("2026-11-27T18:50:00Z"), { sessionDate: "2026-11-27", closeAt: "13:00" })).toBe("retry");
    expect(eodSlot(new Date("2026-11-27T19:35:00Z"), { sessionDate: "2026-11-27", closeAt: "13:00" })).toBe("last");
    expect(eodSlot(new Date("2026-11-27T20:00:00Z"), { sessionDate: "2026-11-27", closeAt: "13:00" })).toBe("deadline");
    expect(() => eodDeadline("2026-02-30", "16:00")).toThrow();
  });
});

describe("bounded manual EOD history request validation", () => {
  it("normalizes explicit security identities and leaves default full-catalog requests optional", () => {
    expect(eodEnqueueSchema.parse({ sessionDate:"2026-09-08",purpose:"backfill",
      historyTickers:[" msft ","brk.b","MSFT","BRK-B"],historySessions:1400 }))
      .toMatchObject({historyTickers:["BRK-B","BRK.B","MSFT"],historySessions:1400});
    expect(eodEnqueueSchema.parse({sessionDate:"2026-09-08",purpose:"backfill"}).historySessions).toBeUndefined();
  });

  it.each([
    {purpose:"daily",historyTickers:["MSFT"]},
    {purpose:"reconcile",historySessions:520},
    {purpose:"maintenance",historySessions:1400,historyTickers:["MSFT"]},
    {purpose:"backfill",historySessions:1400},
    {purpose:"backfill",historySessions:1300,historyTickers:["MSFT"]},
    {purpose:"backfill",historyTickers:[]},
    {purpose:"backfill",historyTickers:Array.from({length:101},(_,index) => `T${index}`)},
    {purpose:"backfill",historyTickers:["MS FT"]},
    {purpose:"backfill",historyTickers:["MSFT;DELETE"]},
  ])("rejects invalid or unbounded history selection %j", (selection) => {
    expect(eodEnqueueSchema.safeParse({sessionDate:"2026-09-08",...selection}).success).toBe(false);
  });
});

describe("EOD durable coordinator against SQLite", { timeout: 30_000 }, () => {
  let market: ReturnType<typeof createSqliteD1>;
  let ops: ReturnType<typeof createSqliteD1>;
  let env: Env;
  const now = new Date("2026-09-08T21:00:00Z");
  const github = vi.fn<typeof fetch>();

  beforeEach(() => {
    market = createSqliteD1();
    ops = createSqliteD1();
    market.migrate("market-data-migrations");
    ops.migrate("ops-migrations");
    market.script(`INSERT INTO market_calendar_sessions(session_date,open_at,close_at,source,fetched_at)
      VALUES('2026-09-04','09:30','16:00','alpaca','2026-09-08'),
      ('2026-09-08','09:30','16:00','alpaca','2026-09-08'),
      ('2026-09-09','09:30','16:00','alpaca','2026-09-08'),
      ('2026-11-27','09:30','13:00','alpaca','2026-09-08');
      INSERT INTO market_calendar_refresh_state(id,covered_start,covered_end,verified_at)
      VALUES('default','2026-09-01','2026-12-31','2026-09-08T21:00:00.000Z');`);
    env = { DB: market.db, MARKET_DATA_DB: market.db, OPS_DB: ops.db, EOD_RUNNER_MODE: "active",
      EOD_GITHUB_TOKEN: "test-only", EOD_GITHUB_REPOSITORY: "test/repo" } as Env;
    github.mockReset().mockImplementation(async (_url, init) => init?.method === "POST"
      ? new Response(null, { status: 204 }) : Response.json({ total_count: 0, workflow_runs: [] }));
    vi.stubGlobal("fetch", github);
  }, 30_000);
  afterEach(async () => {
    market.dispose(); ops.dispose(); vi.unstubAllGlobals(); vi.useRealTimers();
    // The SQLite bridge is synchronous; let Vitest flush result messages
    // between cases instead of starving its IPC heartbeat during a long suite.
    await new Promise((resolve) => setTimeout(resolve,0));
  });
  const storedRun = (id: string) => ops.db.prepare("SELECT * FROM eod_runs WHERE id=?").bind(id).first<EodRun>();
  const posts = () => github.mock.calls.filter(([, init]) => init?.method === "POST");
  it("runs retention in the morning and prioritizes current delivery without replaying old daily work", async () => {
    const morning = new Date("2026-09-09T11:00:00Z");
    await enqueueEodRun(env,"2026-09-04","daily",morning);
    const current = await enqueueEodRun(env,"2026-09-08","daily",morning);
    const maintenance = await enqueueEodRun(env,"2026-09-08","maintenance",morning);
    await dispatchEodRun(env,maintenance,morning);
    expect(posts()).toHaveLength(0);
    await ops.db.prepare("UPDATE eod_runs SET status='completed',completed_input_clock=0 WHERE id=?").bind(current.id).run();
    await dispatchEodRun(env,maintenance,morning);
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(String(posts()[0][1]?.body)).inputs.run_id).toBe(maintenance.id);
  });

  it("does not dispatch retention during the EOD window", async () => {
    const run = await enqueueEodRun(env,"2026-09-04","maintenance",now);
    await dispatchEodRun(env,run,new Date("2026-09-08T21:00:00Z"));
    expect(posts()).toHaveLength(0);
  });

  it("leaves old unfinished daily sessions as diagnostics instead of automatically reconstructing history", async () => {
    const old = await enqueueEodRun(env,"2026-09-04","daily",now);
    const current = await enqueueEodRun(env,"2026-09-08","daily",now);
    await ops.db.prepare("UPDATE eod_runs SET status='completed',completed_input_clock=0 WHERE id=?").bind(current.id).run();
    await coordinateEod(env,new Date("2026-09-09T01:00:00Z"));
    expect(posts()).toHaveLength(0);
    expect((await storedRun(old.id))?.status).toBe("queued");
  });

  it("exposes bounded batch progress without returning the internal checkpoint payload",async()=>{
    const run=await enqueueEodRun(env,"2026-09-08","daily",now);
    await ops.db.prepare("UPDATE eod_runs SET progress_json=? WHERE id=?")
      .bind(JSON.stringify({chunk:5,total:254,symbols:125,privatePayload:"not-public"}),run.id).run();
    const result=(await eodStatus(env,now)).runs[0];
    expect(result.progress).toEqual({completedSymbols:125,completedBatches:5,totalBatches:254});
    expect(JSON.stringify(result)).not.toContain("not-public");
  });
  const activeGithub = (id: string, status = "queued") => ({ id: 42, display_title: `EOD ${id}`,
    status, head_branch: "main", event: "workflow_dispatch" });
  async function publish(scope: string, acceptedAt: string, sessionDate = "2026-09-08", revision = 1) {
    const id = `${scope}:${sessionDate}:${revision}`;
    await market.db.prepare(`INSERT INTO eod_publications(id,scope,session_date,revision,input_hash,methodology_version,
      payload_json,status,created_at,accepted_at) VALUES(?,?,?,?,?,'test','{}','accepted',?,?)`)
      .bind(id,scope,sessionDate,revision,id,acceptedAt,acceptedAt).run();
    await market.db.prepare(`INSERT INTO eod_publication_pointers(scope,publication_id,session_date,published_at)
      VALUES(?,?,?,?) ON CONFLICT(scope) DO UPDATE SET publication_id=excluded.publication_id,
      session_date=excluded.session_date,published_at=excluded.published_at`).bind(scope,id,sessionDate,acceptedAt).run();
  }

  it("enqueues idempotently with actual session deadlines for manual and future dates", async () => {
    const run = await enqueueEodRun(env,"2026-09-08","daily",now);
    expect((await enqueueEodRun(env,"2026-09-08","daily",now)).id).toBe(run.id);
    expect((await storedRun(run.id))?.deadline_at).toBe("2026-09-08T22:00:00.000Z");
    const manual = await enqueueEodRun(env,"2026-11-27","backfill",now);
    expect(manual.deadline_at).toBe("2026-11-27T20:00:00.000Z");
    expect(manual.next_attempt_at).toBe("2026-11-27T18:20:00.000Z");
    await dispatchEodRun(env,{...manual,next_attempt_at:null},now);
    expect(posts()).toHaveLength(0);
    await expect(enqueueEodRun(env,"2026-09-07","daily",now)).rejects.toThrow("Unknown exchange session");
  });

  it("persists a scoped deep request before dispatch and resumes it when retry options are omitted", async () => {
    const run=await enqueueEodRun(env,"2026-09-08","backfill",now,
      {historyTickers:[" msft ","BRK.B","msft"],historySessions:1400});
    expect(run).toMatchObject({history_tickers_json:'["BRK.B","MSFT"]',history_sessions:1400});
    let sentSelection: unknown;
    github.mockImplementation(async (_url,init) => {
      if (init?.method === "POST") {
        sentSelection=await storedRun(run.id);
        return new Response(null,{status:204});
      }
      return Response.json({total_count:0,workflow_runs:[]});
    });
    await dispatchEodRun(env,run,now);
    expect(sentSelection).toMatchObject({history_tickers_json:'["BRK.B","MSFT"]',history_sessions:1400});
    expect(await enqueueEodRun(env,"2026-09-08","backfill",now))
      .toMatchObject({history_tickers_json:'["BRK.B","MSFT"]',history_sessions:1400,status:"dispatched"});
    expect((await eodStatus(env,now)).runs[0]).toMatchObject({historyTickers:["BRK.B","MSFT"],historySessions:1400});
  });

  it("defaults bootstrap and automatic runs to full catalog/520 and rejects direct invalid callers before writes", async () => {
    for (const purpose of ["daily","reconcile","backfill","maintenance"] as const) {
      expect(await enqueueEodRun(env,"2026-09-08",purpose,now))
        .toMatchObject({history_tickers_json:null,history_sessions:520});
    }
    await expect(enqueueEodRun(env,"2026-09-09","daily",now,{historyTickers:["MSFT"]})).rejects.toThrow();
    await expect(enqueueEodRun(env,"2026-09-09","backfill",now,{historySessions:1400})).rejects.toThrow();
    expect(await ops.db.prepare("SELECT id FROM eod_runs WHERE session_date='2026-09-09'").first()).toBeNull();
    // The storage constraint also rejects accidentally unbounded deep requests.
    await expect(ops.db.prepare("UPDATE eod_runs SET history_sessions=1400 WHERE purpose='maintenance'").run()).rejects.toThrow();
  });

  it("requeues a changed completed request and clears only that run's frozen computation state", async () => {
    const run=await enqueueEodRun(env,"2026-09-08","backfill",now);
    const other=await enqueueEodRun(env,"2026-09-08","daily",now);
    await ops.db.prepare(`UPDATE eod_runs SET status='completed',stage='completed',input_json='{"old":true}',
      progress_json='{"history":{"cursor":5}}',completed_at=?,error_code='old-error' WHERE id=?`)
      .bind(now.toISOString(),run.id).run();
    const updated=await enqueueEodRun(env,"2026-09-08","backfill",now,{historyTickers:["MSFT"],historySessions:1400});
    expect(updated).toMatchObject({status:"queued",stage:"queued",history_tickers_json:'["MSFT"]',history_sessions:1400,
      input_json:"{}",progress_json:"{}",error_code:null,next_attempt_at:now.toISOString()});
    expect(await ops.db.prepare("SELECT completed_at FROM eod_runs WHERE id=?").bind(run.id).first()).toEqual({completed_at:null});
    expect(await storedRun(other.id)).toEqual(other);
    // Supplying 520 explicitly with no tickers selects the full catalog again.
    expect(await enqueueEodRun(env,"2026-09-08","backfill",now,{historySessions:520}))
      .toMatchObject({history_tickers_json:null,history_sessions:520});
  });

  it.each(["running","dispatching","dispatched"])("does not change a %s run's request", async (status) => {
    const run=await enqueueEodRun(env,"2026-09-08","backfill",now,{historyTickers:["MSFT"]});
    await ops.db.prepare("UPDATE eod_runs SET status=?,input_json=? WHERE id=?")
      .bind(status,JSON.stringify({frozen:true}),run.id).run();
    const before=await storedRun(run.id);
    await expect(enqueueEodRun(env,"2026-09-08","backfill",now,{historyTickers:["AAPL"]}))
      .rejects.toBeInstanceOf(EodHistoryRequestBusyError);
    expect(await storedRun(run.id)).toEqual(before);
    expect(await enqueueEodRun(env,"2026-09-08","backfill",now,{historyTickers:["msft"]})).toEqual(before);
    expect(github).not.toHaveBeenCalled();
  });

  it("protects a live lease and an ambiguously dispatched GitHub run before allowing changed input", async () => {
    const run=await enqueueEodRun(env,"2026-09-08","backfill",now);
    await ops.db.prepare("UPDATE eod_runs SET status='retrying',lease_until=? WHERE id=?")
      .bind("2026-09-08T21:10:00.000Z",run.id).run();
    await expect(enqueueEodRun(env,"2026-09-08","backfill",now,{historyTickers:["MSFT"]}))
      .rejects.toBeInstanceOf(EodHistoryRequestBusyError);
    expect(github).not.toHaveBeenCalled();
    await ops.db.prepare("UPDATE eod_runs SET lease_until=NULL,dispatch_requested_at=? WHERE id=?").bind(now.toISOString(),run.id).run();
    github.mockImplementation(async () => Response.json({total_count:1,workflow_runs:[activeGithub(run.id)]}));
    await expect(enqueueEodRun(env,"2026-09-08","backfill",now,{historyTickers:["MSFT"]}))
      .rejects.toBeInstanceOf(EodHistoryRequestBusyError);
    github.mockResolvedValue(new Response(null,{status:503}));
    await expect(enqueueEodRun(env,"2026-09-08","backfill",now,{historyTickers:["MSFT"]}))
      .rejects.toBeInstanceOf(EodHistoryRequestBusyError);
    expect((await storedRun(run.id))?.history_tickers_json).toBeNull();
  });

  it("loses a history-change race safely when a runner claims during the GitHub check", async () => {
    const run=await enqueueEodRun(env,"2026-09-08","backfill",now);
    await ops.db.prepare("UPDATE eod_runs SET status='retrying',dispatch_requested_at=? WHERE id=?").bind(now.toISOString(),run.id).run();
    let claimed=false;
    github.mockImplementation(async () => {
      if (!claimed) {
        claimed=true;
        await ops.db.prepare("UPDATE eod_runs SET status='running',lease_until='2026-09-08T22:00:00.000Z' WHERE id=?").bind(run.id).run();
      }
      return Response.json({total_count:0,workflow_runs:[]});
    });
    await expect(enqueueEodRun(env,"2026-09-08","backfill",now,{historyTickers:["MSFT"]}))
      .rejects.toBeInstanceOf(EodHistoryRequestBusyError);
    expect(await storedRun(run.id)).toMatchObject({status:"running",history_tickers_json:null,history_sessions:520});
  });

  it("returns the persisted history selection and a reviewable conflict from the authenticated API", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const app=new Hono<{Bindings:Env}>();
    registerEodRoutes(app);
    const body={sessionDate:"2026-09-08",purpose:"backfill",historyTickers:["msft"],historySessions:1400};
    const call=(selection:unknown,authorized=true) => app.request("/api/admin/eod/runs",{method:"POST",
      headers:{"Content-Type":"application/json",...(authorized ? {Authorization:"Bearer test-only"} : {})},
      body:JSON.stringify(selection)}, {...env,ADMIN_SECRET:"test-only"});
    expect((await call(body,false)).status).toBe(401);
    expect(github).not.toHaveBeenCalled();
    expect((await call({...body,purpose:"maintenance"})).status).toBe(400);
    const result=await call(body);
    expect(result.status).toBe(202);
    expect(await result.json()).toEqual({runId:"eod:active:2026-09-08:backfill",status:"dispatched",
      historyTickers:["MSFT"],historySessions:1400});
    const conflict=await call({...body,historyTickers:["AAPL"]});
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({error:"history-request-busy"});
    expect(posts()).toHaveLength(1);
  });

  it("resolves holidays and early closes from stored exchange sessions without writes", async () => {
    expect(await expectedEodSession(env,new Date("2026-09-07T23:00:00Z"))).toBe("2026-09-04");
    expect(await expectedEodSession(env,new Date("2026-09-08T19:59:00Z"))).toBe("2026-09-04");
    expect(await expectedEodSession(env,new Date("2026-11-27T18:00:00Z"))).toBe("2026-11-27");
    await market.db.prepare("UPDATE market_calendar_refresh_state SET covered_end='2026-09-04'").run();
    expect(await expectedEodSession(env,new Date("2026-09-08T22:00:00Z"))).toBeNull();
  });

  it("preserves exact close boundaries, New York midnight and winter offsets", async () => {
    market.script(`INSERT INTO market_calendar_sessions(session_date,open_at,close_at,source)
      VALUES('2026-01-02','09:30','16:00','fixture'),('2026-01-05','09:30','16:00','fixture'),
        ('2026-11-25','09:30','16:00','fixture');
      UPDATE market_calendar_refresh_state SET covered_start='2026-01-01';`);
    for (const [timestamp, expected] of [
      ["2026-01-05T20:59:59Z", "2026-01-02"],
      ["2026-01-05T21:00:00Z", "2026-01-05"],
      ["2026-09-08T19:59:59Z", "2026-09-04"],
      ["2026-09-08T20:00:00Z", "2026-09-08"],
      ["2026-09-09T03:59:59Z", "2026-09-08"],
      ["2026-09-09T04:00:00Z", "2026-09-08"],
      ["2026-11-26T23:00:00Z", "2026-11-25"],
      ["2026-11-27T17:59:59Z", "2026-11-25"],
      ["2026-11-27T18:00:00Z", "2026-11-27"],
    ]) expect(await expectedEodSession(env, new Date(timestamp))).toBe(expected);
  });

  it("seeks the calendar primary-key range without scanning or sorting retained history", async () => {
    market.script(`WITH RECURSIVE dates(d) AS (
      VALUES('2020-01-01') UNION ALL SELECT date(d,'+1 day') FROM dates WHERE d<'2025-12-31'
    ) INSERT INTO market_calendar_sessions(session_date,open_at,close_at,source)
      SELECT d,'09:30','16:00','fixture' FROM dates;`);
    const spy = vi.spyOn(market.db, "prepare");
    let sql: string;
    try {
      expect(await expectedEodSession(env, new Date("2026-09-08T19:59:00Z"))).toBe("2026-09-04");
      expect(spy).toHaveBeenCalledOnce();
      sql = spy.mock.calls[0][0];
    } finally { spy.mockRestore(); }
    const plan = await market.db.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind("2026-09-08", "2026-09-08", "15:59", "2026-09-08", "2026-09-08")
      .all<{detail: string}>();
    const details = plan.results.map((row) => row.detail).join("\n");
    expect(details).toMatch(/SEARCH market_calendar_sessions USING PRIMARY KEY \(session_date<\?\)/);
    expect(details).not.toMatch(/MULTI-INDEX OR|TEMP B-TREE|SCAN market_calendar_sessions/);
  });

  it("does not dispatch twice after GitHub accepts a run that remains queued", async () => {
    const run = await enqueueEodRun(env,"2026-09-08","daily",now);
    await dispatchEodRun(env,run,now);
    expect(posts()).toHaveLength(1);
    expect((await storedRun(run.id))?.attempt).toBe(1);
    github.mockImplementation(async (_url, init) => init?.method === "POST" ? new Response(null,{status:204})
      : Response.json({ total_count: 1, workflow_runs: [activeGithub(run.id)] }));
    await dispatchEodRun(env,(await storedRun(run.id))!,new Date("2026-09-08T21:16:00Z"));
    expect(posts()).toHaveLength(1);
    expect(await storedRun(run.id)).toMatchObject({github_run_id:"42",attempt:1,status:"dispatched"});
    github.mockResolvedValue(Response.json(activeGithub(run.id,"in_progress")));
    await dispatchEodRun(env,(await storedRun(run.id))!,new Date("2026-09-08T21:32:00Z"));
    expect(posts()).toHaveLength(1);
  });

  it.each([
    {eodReads:2_499_900,reservedReads:100,eodWrites:0,reservedWrites:0,accountReads:null,accountWrites:null},
    {eodReads:0,reservedReads:0,eodWrites:49_950,reservedWrites:50,accountReads:null,accountWrites:null},
    {eodReads:0,reservedReads:50,eodWrites:0,reservedWrites:0,accountReads:4_499_950,accountWrites:0},
    {eodReads:0,reservedReads:0,eodWrites:0,reservedWrites:30,accountReads:0,accountWrites:89_970},
    {eodReads:2_499_950,reservedReads:0,eodWrites:0,reservedWrites:0,accountReads:null,accountWrites:null},
    {eodReads:0,reservedReads:0,eodWrites:49_950,reservedWrites:0,accountReads:null,accountWrites:null},
  ])("defers known exhausted or insufficient control quota without any GitHub request %j", async (usage) => {
    const run=await enqueueEodRun(env,"2026-09-08","daily",now);
    await ops.db.prepare("INSERT INTO eod_usage(usage_date,rows_read,rows_written,reserved_reads,reserved_writes) VALUES(?,?,?,?,?)")
      .bind("2026-09-08",usage.eodReads,usage.eodWrites,usage.reservedReads,usage.reservedWrites).run();
    if (usage.accountReads!==null) await ops.db.prepare("INSERT INTO market_data_daily_usage(usage_date,rows_read,rows_written) VALUES(?,?,?)")
      .bind("2026-09-08",usage.accountReads,usage.accountWrites).run();
    await dispatchEodRun(env,run,now);
    const deferred=await storedRun(run.id);
    expect(deferred).toMatchObject({status:"retrying",stage:"dispatch-budget",error_code:"resource-budget",attempt:0,
      next_attempt_at:"2026-09-09T00:05:00.000Z"});
    expect(github).not.toHaveBeenCalled();
    // Even an overlapping caller holding the pre-deferral row cannot rewrite it.
    await dispatchEodRun(env,run,new Date("2026-09-08T21:01:00Z"));
    expect(await storedRun(run.id)).toEqual(deferred);
    expect(github).not.toHaveBeenCalled();
  });

  it("checks known account exhaustion without an EOD ledger and permits a fresh UTC allowance", async () => {
    const run=await enqueueEodRun(env,"2026-09-08","daily",now);
    await ops.db.prepare("INSERT INTO market_data_daily_usage(usage_date,rows_read,rows_written) VALUES('2026-09-08',4500000,0)").run();
    await dispatchEodRun(env,run,now);
    expect(await storedRun(run.id)).toMatchObject({error_code:"resource-budget",next_attempt_at:"2026-09-09T00:05:00.000Z"});
    await dispatchEodRun(env,(await storedRun(run.id))!,new Date("2026-09-09T00:04:00Z"));
    expect(github).not.toHaveBeenCalled();
    await dispatchEodRun(env,(await storedRun(run.id))!,new Date("2026-09-09T00:05:00Z"));
    expect(posts()).toHaveLength(1);
    expect(await storedRun(run.id)).toMatchObject({status:"dispatched",attempt:1});
  });

  it("does not change a healthy lease or later scheduled retry when the quota ledger is exhausted", async () => {
    const running=await enqueueEodRun(env,"2026-09-08","daily",now);
    const retry=await enqueueEodRun(env,"2026-09-08","reconcile",now);
    await ops.db.prepare("UPDATE eod_runs SET status='running',lease_until='2026-09-08T22:00:00.000Z' WHERE id=?").bind(running.id).run();
    await ops.db.prepare("UPDATE eod_runs SET status='retrying',next_attempt_at='2026-09-09T01:00:00.000Z' WHERE id=?").bind(retry.id).run();
    await ops.db.prepare("INSERT INTO eod_usage(usage_date,rows_read,rows_written) VALUES('2026-09-08',2500000,50000)").run();
    const beforeRunning=await storedRun(running.id),beforeRetry=await storedRun(retry.id);
    await dispatchEodRun(env,beforeRunning!,now);
    await dispatchEodRun(env,beforeRetry!,now);
    expect(await storedRun(running.id)).toEqual(beforeRunning);
    expect(await storedRun(retry.id)).toEqual(beforeRetry);
    expect(github).not.toHaveBeenCalled();
  });

  it("respects live worker leases, retry times and overlapping coordinator dispatch claims", async () => {
    const run = await enqueueEodRun(env,"2026-09-08","daily",now);
    await Promise.all([dispatchEodRun(env,run,now),dispatchEodRun(env,run,now)]);
    expect(posts()).toHaveLength(1);
    await ops.db.prepare("UPDATE eod_runs SET status='running',lease_until=?,next_attempt_at=NULL WHERE id=?")
      .bind("2026-09-08T22:00:00.000Z",run.id).run();
    await dispatchEodRun(env,(await storedRun(run.id))!,new Date("2026-09-08T21:30:00Z"));
    expect(posts()).toHaveLength(1);
  });

  it("reconciles an ambiguous POST timeout and fails closed when GitHub lookup is unavailable", async () => {
    const run = await enqueueEodRun(env,"2026-09-08","daily",now);
    github.mockImplementation(async (_url, init) => {
      if (init?.method === "POST") throw new Error("request timed out after GitHub accepted it");
      return Response.json({ total_count:0,workflow_runs:[] });
    });
    await expect(dispatchEodRun(env,run,now)).rejects.toThrow("timed out");
    github.mockImplementation(async () => Response.json({total_count:1,workflow_runs:[activeGithub(run.id,"waiting")]}));
    await dispatchEodRun(env,(await storedRun(run.id))!,new Date("2026-09-08T21:16:00Z"));
    expect(posts()).toHaveLength(1);
    github.mockResolvedValue(new Response(null,{status:503}));
    await expect(dispatchEodRun(env,(await storedRun(run.id))!,new Date("2026-09-08T21:32:00Z"))).rejects.toThrow("github-run-check-http-503");
    expect(posts()).toHaveLength(1);
  });

  it("records deadline success while catalog ingestion remains running", async () => {
    const run = await enqueueEodRun(env,"2026-09-08","daily",now);
    await ops.db.prepare("UPDATE eod_runs SET status='running',stage='catalog' WHERE id=?").bind(run.id).run();
    for (const scope of EOD_PUBLICATION_SCOPES) await publish(scope,"2026-09-08T21:50:00.000Z");
    // A later correction must not erase the fact the page originally met SLA.
    await publish("overview:default","2026-09-08T22:10:00.000Z","2026-09-08",2);
    await checkEodDeadlines(env,new Date("2026-09-08T22:15:00Z"));
    expect(await storedRun(run.id)).toMatchObject({status:"running",deadline_missed:0,
      deadline_checked_at:"2026-09-08T22:15:00.000Z",deadline_missing_scopes_json:"[]"});
  });

  it("records a missing scope even if the run completed and preserves the missed outcome after recovery", async () => {
    const run = await enqueueEodRun(env,"2026-09-08","daily",now);
    await ops.db.prepare("UPDATE eod_runs SET status='completed' WHERE id=?").bind(run.id).run();
    for (const scope of EOD_PUBLICATION_SCOPES.slice(0,5)) await publish(scope,"2026-09-08T21:50:00.000Z");
    await checkEodDeadlines(env,new Date("2026-09-08T22:00:00Z"));
    expect(await storedRun(run.id)).toMatchObject({deadline_missed:1,
      deadline_missing_scopes_json:JSON.stringify([EOD_PUBLICATION_SCOPES[5]])});
    await publish(EOD_PUBLICATION_SCOPES[5],"2026-09-08T22:01:00.000Z");
    await checkEodDeadlines(env,new Date("2026-09-08T22:02:00Z"));
    expect((await storedRun(run.id))?.deadline_missed).toBe(1);
  });

  it("recovers a quota-blocked session after its UTC reset outside the close window", async () => {
    const run = await enqueueEodRun(env,"2026-09-08","daily",now);
    await ops.db.prepare("UPDATE eod_runs SET status='retrying',error_code='resource-budget',next_attempt_at=? WHERE id=?")
      .bind("2026-09-09T00:05:00.000Z",run.id).run();
    await coordinateEod(env,new Date("2026-09-09T00:04:00Z"));
    expect(posts()).toHaveLength(0);
    await coordinateEod(env,new Date("2026-09-09T00:06:00Z"));
    expect(posts()).toHaveLength(1);
    expect((await storedRun(run.id))?.deadline_missed).toBe(1);
  });

  it("reports independent scope health and truthful unknown quotas without dispatching or writing", async () => {
    const run = await enqueueEodRun(env,"2026-09-08","daily",now);
    await ops.db.prepare("UPDATE eod_runs SET status='retrying',stage='prices',error_code='resource-budget',error_message='quota exhausted',progress_json=? WHERE id=?")
      .bind(JSON.stringify({errors:{AAA:"alpaca-http-429"}}),run.id).run();
    for (const scope of EOD_PUBLICATION_SCOPES.slice(0,5)) await publish(scope,"2026-09-08T21:50:00.000Z");
    const before=await storedRun(run.id);
    const status=await eodStatus(env,new Date("2026-09-08T22:00:00Z"));
    expect(status.ready).toBe(false);
    expect(status.missingScopes).toEqual([EOD_PUBLICATION_SCOPES[5]]);
    expect(status.lastSuccessfulSession).toBeNull();
    expect(status.quota).toMatchObject({status:"blocked",rowsRead:null,resetAt:"2026-09-09T00:00:00.000Z"});
    expect(status.accountUsage).toBeNull();
    expect(status.runs[0]).toMatchObject({failedStage:"prices",providerErrors:{AAA:"alpaca-http-429"}});
    expect(await storedRun(run.id)).toEqual(before);
    expect(github).not.toHaveBeenCalled();
  });

  it("reports superseded inputs even when all six publication session dates match, without writing", async () => {
    const run=await enqueueEodRun(env,"2026-09-08","daily",now);
    await ops.db.prepare("UPDATE eod_runs SET status='completed',completed_input_clock=3,completed_at=? WHERE id=?")
      .bind(now.toISOString(),run.id).run();
    await market.db.prepare("UPDATE eod_input_clock SET revision=4 WHERE id='default'").run();
    for (const scope of EOD_PUBLICATION_SCOPES) await publish(scope,now.toISOString());
    const before=await storedRun(run.id);
    const status=await eodStatus(env,now);
    expect(status).toMatchObject({expectedSession:"2026-09-08",missingScopes:[],ready:false,
      inputCorrectionsPending:true,inputRevision:4,completedInputRevision:3});
    expect(await storedRun(run.id)).toEqual(before);
    expect(github).not.toHaveBeenCalled();
    await ops.db.prepare("UPDATE eod_runs SET completed_input_clock=4 WHERE id=?").bind(run.id).run();
    expect(await eodStatus(env,now)).toMatchObject({ready:true,inputCorrectionsPending:false});
  });

  it("requests one reconcile for a legacy null watermark and stops after the new completed watermark", async () => {
    const run=await enqueueEodRun(env,"2026-09-08","daily",now);
    await ops.db.prepare("UPDATE eod_runs SET status='completed',completed_at=? WHERE id=?").bind(now.toISOString(),run.id).run();
    expect(await eodInputCorrectionStatus(env,"2026-09-08"))
      .toMatchObject({inputCorrectionsPending:true,completedInputRevision:null,inputRevision:0});
    await scheduleEodInputCorrections(env,"2026-09-08",now);
    const reconcileId="eod:active:2026-09-08:reconcile";
    expect(await storedRun(reconcileId)).toMatchObject({status:"queued"});
    await ops.db.prepare("UPDATE eod_runs SET progress_json=? WHERE id=?").bind(JSON.stringify({cursor:4}),reconcileId).run();
    const queued=await storedRun(reconcileId);
    await scheduleEodInputCorrections(env,"2026-09-08",new Date("2026-09-08T21:05:00Z"));
    expect(await storedRun(reconcileId)).toEqual(queued);
    await ops.db.prepare(`UPDATE eod_runs SET status='completed',completed_input_clock=0,
      completed_at='2026-09-08T21:10:00.000Z',updated_at='2026-09-08T21:10:00.000Z' WHERE id=?`).bind(reconcileId).run();
    const completed=await storedRun(reconcileId);
    await scheduleEodInputCorrections(env,"2026-09-08",new Date("2026-09-08T21:15:00Z"));
    expect(await storedRun(reconcileId)).toEqual(completed);
    expect(await eodInputCorrectionStatus(env,"2026-09-08")).toMatchObject({inputCorrectionsPending:false});
    expect(github).not.toHaveBeenCalled();
  });

  it("does not requeue when a completion race exposes a watermark newer than the separately sampled clock", async () => {
    const run=await enqueueEodRun(env,"2026-09-08","daily",now);
    await ops.db.prepare("UPDATE eod_runs SET status='completed',completed_input_clock=5 WHERE id=?").bind(run.id).run();
    await market.db.prepare("UPDATE eod_input_clock SET revision=4 WHERE id='default'").run();
    expect(await eodInputCorrectionStatus(env,"2026-09-08"))
      .toMatchObject({inputRevision:4,completedInputRevision:5,inputCorrectionsPending:null});
    await scheduleEodInputCorrections(env,"2026-09-08",now);
    expect(await ops.db.prepare("SELECT id FROM eod_runs WHERE purpose='reconcile'").first()).toBeNull();
    await market.db.prepare("UPDATE eod_input_clock SET revision=5 WHERE id='default'").run();
    expect(await eodInputCorrectionStatus(env,"2026-09-08")).toMatchObject({inputCorrectionsPending:false});
  });

  it.each(["retrying","running","dispatching","dispatched"])("preserves %s correction recovery state and its UTC retry", async (status) => {
    const daily=await enqueueEodRun(env,"2026-09-08","daily",now);
    await ops.db.prepare("UPDATE eod_runs SET status='completed',completed_input_clock=0 WHERE id=?").bind(daily.id).run();
    await market.db.prepare("UPDATE eod_input_clock SET revision=1 WHERE id='default'").run();
    const reconcile=await enqueueEodRun(env,"2026-09-08","reconcile",now);
    await ops.db.prepare(`UPDATE eod_runs SET status=?,progress_json=?,next_attempt_at='2026-09-09T00:05:00.000Z',
      lease_until=? WHERE id=?`).bind(status,JSON.stringify({cursor:40}),status==="running" ? "2026-09-08T22:00:00.000Z" : null,reconcile.id).run();
    const before=await storedRun(reconcile.id);
    await scheduleEodInputCorrections(env,"2026-09-08",now);
    expect(await storedRun(reconcile.id)).toEqual(before);
    expect(github).not.toHaveBeenCalled();
  });

  it("requeues a completed reconcile after a new correction, while retaining a live completion lease", async () => {
    const reconcile=await enqueueEodRun(env,"2026-09-08","reconcile",now);
    await ops.db.prepare(`UPDATE eod_runs SET status='completed',completed_input_clock=0,
      input_json='{"frozen":true}',progress_json='{"cursor":10}',completed_at=?,lease_until=? WHERE id=?`)
      .bind(now.toISOString(),"2026-09-08T21:10:00.000Z",reconcile.id).run();
    await market.db.prepare("UPDATE eod_input_clock SET revision=1 WHERE id='default'").run();
    const leased=await storedRun(reconcile.id);
    await scheduleEodInputCorrections(env,"2026-09-08",now);
    expect(await storedRun(reconcile.id)).toEqual(leased);
    await scheduleEodInputCorrections(env,"2026-09-08",new Date("2026-09-08T21:11:00Z"));
    expect(await storedRun(reconcile.id)).toMatchObject({status:"queued",input_json:"{}",progress_json:"{}"});
  });

  it("does not invent correction readiness or create recovery for missing session/clock/completion evidence", async () => {
    expect(await eodInputCorrectionStatus(env,null)).toMatchObject({inputCorrectionsPending:null,inputRevision:null});
    expect(await eodInputCorrectionStatus(env,"2026-09-08")).toMatchObject({inputCorrectionsPending:null,completedRunId:null});
    await scheduleEodInputCorrections(env,"2026-09-08",now);
    expect(await ops.db.prepare("SELECT id FROM eod_runs").first()).toBeNull();
    const previous=await enqueueEodRun(env,"2026-09-04","daily",now);
    await ops.db.prepare("UPDATE eod_runs SET status='completed' WHERE id=?").bind(previous.id).run();
    await scheduleEodInputCorrections(env,"2026-09-08",now);
    expect(await ops.db.prepare("SELECT id FROM eod_runs WHERE purpose='reconcile'").first()).toBeNull();
    await market.db.prepare("DELETE FROM eod_input_clock WHERE id='default'").run();
    expect(await eodStatus(env,now)).toMatchObject({ready:false,inputCorrectionsPending:null,inputRevision:null});
    await scheduleEodInputCorrections(env,"2026-09-04",now);
    expect(await ops.db.prepare("SELECT id FROM eod_runs WHERE purpose='reconcile'").first()).toBeNull();
  });

  it("automatically dispatches correction recovery outside delivery windows without duplicate resets", async () => {
    const daily=await enqueueEodRun(env,"2026-09-08","daily",now);
    await ops.db.prepare("UPDATE eod_runs SET status='completed',completed_input_clock=0,completed_at=? WHERE id=?")
      .bind(now.toISOString(),daily.id).run();
    await market.db.prepare("UPDATE eod_input_clock SET revision=1 WHERE id='default'").run();
    await coordinateEod(env,new Date("2026-09-09T00:06:00Z"));
    expect(posts()).toHaveLength(1);
    const id="eod:active:2026-09-08:reconcile";
    const dispatched=await storedRun(id);
    expect(dispatched).toMatchObject({status:"dispatched",attempt:1});
    await coordinateEod(env,new Date("2026-09-09T00:07:00Z"));
    expect(posts()).toHaveLength(1);
    expect(await storedRun(id)).toMatchObject({status:dispatched?.status,attempt:dispatched?.attempt,
      input_json:dispatched?.input_json,progress_json:dispatched?.progress_json,next_attempt_at:dispatched?.next_attempt_at});
  });

  it("reports measured account usage separately from runner-reserved usage", async () => {
    await ops.db.prepare(`INSERT INTO eod_account_usage(usage_date,rows_read,rows_written,sampled_at,error)
      VALUES('2026-09-08',4000000,70000,'2026-09-08T21:00:00.000Z',NULL)`).run();
    const status=await eodStatus(env,now);
    expect(status.accountUsage).toEqual({usage_date:"2026-09-08",rows_read:4000000,rows_written:70000,
      sampled_at:"2026-09-08T21:00:00.000Z",error:null});
    expect(status.quota?.rowsRead).toBeNull();
    expect(github).not.toHaveBeenCalled();
    const nextDay=await eodStatus(env,new Date("2026-09-09T00:01:00Z"));
    expect(nextDay.accountUsage).toBeNull();
  });

  it("reads the last complete six-scope delivery from the indexed run ledger", async () => {
    const old=await enqueueEodRun(env,"2026-09-04","daily",now);
    const complete=JSON.stringify({published:EOD_PUBLICATION_SCOPES.map((scope) => `${scope}:publication-id`)});
    await ops.db.prepare("UPDATE eod_runs SET status='completed',progress_json=? WHERE id=?").bind(complete,old.id).run();
    const maintenance=await enqueueEodRun(env,"2026-09-08","maintenance",now);
    await ops.db.prepare("UPDATE eod_runs SET status='completed',progress_json=? WHERE id=?").bind(complete,maintenance.id).run();
    const shadow=await enqueueEodRun({...env,EOD_RUNNER_MODE:"shadow"},"2026-09-08","daily",now);
    await ops.db.prepare("UPDATE eod_runs SET status='completed',progress_json=? WHERE id=?").bind(complete,shadow.id).run();
    const partial=await enqueueEodRun(env,"2026-09-08","reconcile",now);
    await ops.db.prepare("UPDATE eod_runs SET status='completed',progress_json=? WHERE id=?")
      .bind(JSON.stringify({published:["overview-id"]}),partial.id).run();
    expect((await eodStatus(env,now)).lastSuccessfulSession).toBe("2026-09-04");
    await ops.db.prepare("UPDATE eod_runs SET progress_json=? WHERE id=?").bind(complete,partial.id).run();
    const latest=await eodStatus(env,now);
    expect(latest.lastSuccessfulSession).toBe("2026-09-08");
    expect(latest.ready).toBe(false); // Readiness still independently requires all six accepted heads.
    const plan=await ops.db.prepare(`EXPLAIN QUERY PLAN SELECT session_date AS date FROM eod_runs
      WHERE mode='active' AND status='completed' AND purpose IN ('daily','reconcile') AND session_date<=?
        AND json_array_length(progress_json,'$.published')=6 ORDER BY session_date DESC LIMIT 1`)
      .bind("2026-09-08").all<{detail:string}>();
    expect(plan.results.map((row) => row.detail).join(" ")).toContain("eod_runs_completed_delivery");
  });
});
