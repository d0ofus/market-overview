import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureMarketCalendarCoverage } from "../src/market-calendar-cache";
import { expectedEodSession } from "../src/eod-coordinator";
import { meteredFetch } from "../src/provider-usage";
import { createSqliteD1 } from "./helpers/sqlite-d1";
import type { Env } from "../src/types";

vi.mock("../src/provider-usage", async (original) => ({
  ...await original<typeof import("../src/provider-usage")>(), meteredFetch: vi.fn(),
}));
const request = vi.mocked(meteredFetch);
type OfficialRow = { date:string;open:string;close:string };
function officialRows(url:string):OfficialRow[] {
  const params = new URL(url).searchParams;
  const end = params.get("end")!;
  const rows:OfficialRow[] = [];
  for (const date = new Date(`${params.get("start")}T00:00:00Z`); date.toISOString().slice(0,10)<=end; date.setUTCDate(date.getUTCDate()+1)) {
    if (![0,6].includes(date.getUTCDay())) rows.push({date:date.toISOString().slice(0,10),open:"09:30",close:"16:00"});
  }
  return rows;
}

describe("calendar range publication against SQLite", {timeout:20_000}, () => {
  let storage:ReturnType<typeof createSqliteD1>;
  let env:Env;
  let failUpsert:number|null;
  let writes:Array<{sql:string;params:unknown[]}>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-09T21:00:00.000Z"));
    storage=createSqliteD1(); storage.migrate("market-data-migrations");
    writes=[]; failUpsert=null;
    let upserts=0;
    const tracked={...storage.db,prepare(sql:string) {
      const wrap=(statement:D1PreparedStatement,params:unknown[]=[]):D1PreparedStatement => ({
        bind:(...args:unknown[]) => wrap(statement.bind(...args),args),
        first:statement.first.bind(statement),all:statement.all.bind(statement),raw:statement.raw?.bind(statement),
        async run<T>() {
          writes.push({sql,params});
          if (sql.includes("INSERT INTO market_calendar_sessions") && ++upserts===failUpsert) throw new Error("simulated-calendar-write-failure");
          return statement.run<T>();
        },
      });
      return wrap(storage.db.prepare(sql));
    }} as D1Database;
    env={DB:storage.db,MARKET_DATA_DB:tracked,ALPACA_API_KEY:"test-only",ALPACA_API_SECRET:"test-only"} as Env;
    request.mockReset().mockImplementation(async (_env,url) => Response.json(officialRows(String(url))));
  },30_000);
  afterEach(() => {storage.dispose();vi.useRealTimers();});
  const marker=() => storage.db.prepare("SELECT * FROM market_calendar_refresh_state WHERE id='default'").first();
  async function seedMarker() {
    await storage.db.prepare(`INSERT INTO market_calendar_refresh_state(id,covered_start,covered_end,verified_at)
      VALUES('default','2018-01-01','2027-05-31','2026-08-01T00:00:00.000Z')`).run();
  }
  async function seedSession(date:string) {
    await storage.db.prepare(`INSERT INTO market_calendar_sessions(session_date,open_at,close_at,source)
      VALUES(?,'09:30','16:00','previous-calendar')`).bind(date).run();
  }

  it("preserves the current verified range during old backfill and writes at most400 sessions per statement", async () => {
    await seedMarker();
    request.mockImplementation(async (_env,url) => {const rows=officialRows(String(url));return Response.json([...rows.reverse(),rows[0]]);});
    await ensureMarketCalendarCoverage(env,"2020-05-20","2013-01-01");
    const params=new URL(String(request.mock.calls[0]![1])).searchParams;
    expect(params.get("start")).toBe("2013-01-01");
    expect(params.get("end")).toBe("2027-05-31");
    expect(await marker()).toMatchObject({covered_start:"2013-01-01",covered_end:"2027-05-31"});
    expect(await expectedEodSession(env)).toBe("2026-09-09");
    const chunks=writes.filter((write) => write.sql.includes("INSERT INTO market_calendar_sessions"));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((write) => JSON.parse(String(write.params[1])).length<=400)).toBe(true);
    expect(writes.at(-1)?.sql).toContain("INSERT INTO market_calendar_refresh_state");
    await ensureMarketCalendarCoverage(env,"2020-05-20","2013-01-01");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("requests today's90 future sessions even when only a historical session was requested", async () => {
    await ensureMarketCalendarCoverage(env,"2020-05-20");
    const params=new URL(String(request.mock.calls[0]![1])).searchParams;
    expect(params.get("end")!>="2027-01-27").toBe(true);
    expect(await expectedEodSession(env)).toBe("2026-09-09");
    const count=await storage.db.prepare("SELECT COUNT(*) AS count FROM market_calendar_sessions WHERE session_date>'2026-09-09'").first<{count:number}>();
    expect(count!.count).toBeGreaterThanOrEqual(90);
  });

  it("removes an official closure and corrects early close hours without deleting unrelated history", async () => {
    await seedMarker();
    await seedSession("2001-01-02"); await seedSession("2026-09-09"); await seedSession("2026-11-27");
    request.mockImplementation(async (_env,url) => Response.json(officialRows(String(url))
      .filter((row) => row.date!=="2026-09-09").map((row) => row.date==="2026-11-27" ? {...row,close:"13:00"} : row)));
    await ensureMarketCalendarCoverage(env,"2026-09-09");
    expect(await storage.db.prepare("SELECT close_at FROM market_calendar_sessions WHERE session_date='2026-11-27'").first()).toEqual({close_at:"13:00"});
    expect(await storage.db.prepare("SELECT session_date FROM market_calendar_sessions WHERE session_date='2026-09-09'").first()).toBeNull();
    expect(await storage.db.prepare("SELECT session_date FROM market_calendar_sessions WHERE session_date='2001-01-02'").first()).toEqual({session_date:"2001-01-02"});
    expect(await expectedEodSession(env)).toBe("2026-09-08");
  });

  it("never advances range proof or deletes cached dates after an interrupted chunk write", async () => {
    await seedMarker(); await seedSession("2026-09-09");
    const before=await marker(); failUpsert=2;
    request.mockImplementation(async (_env,url) => Response.json(officialRows(String(url)).filter((row) => row.date!=="2026-09-09")));
    await expect(ensureMarketCalendarCoverage(env,"2020-05-20")).rejects.toThrow("simulated-calendar-write-failure");
    expect(await marker()).toEqual(before);
    expect(writes.some((write) => write.sql.startsWith("DELETE"))).toBe(false);
    expect(await storage.db.prepare("SELECT session_date FROM market_calendar_sessions WHERE session_date='2026-09-09'").first()).not.toBeNull();
    failUpsert=null; await ensureMarketCalendarCoverage(env,"2020-05-20");
    expect((await marker())?.verified_at).toBe("2026-09-09T21:00:00.000Z");
  });

  it.each(["history","future","gap","malformed"] as const)("rejects incomplete %s coverage before writes", async (failure) => {
    await seedMarker(); const before=await marker();
    request.mockImplementation(async (_env,url) => {
      let rows=officialRows(String(url));
      if (failure==="history") rows=rows.filter((row) => row.date>="2026-01-01");
      if (failure==="future") rows=rows.filter((row) => row.date<="2026-09-30");
      if (failure==="gap") rows=rows.filter((row) => row.date<"2025-01-01" || row.date>"2025-02-01");
      if (failure==="malformed") rows.push({date:"2026-02-30",open:"09:30",close:"16:00"});
      return Response.json(rows);
    });
    await expect(ensureMarketCalendarCoverage(env,"2026-09-09")).rejects.toThrow(/calendar/);
    expect(writes).toEqual([]); expect(await marker()).toEqual(before);
  });
});
