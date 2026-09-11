import { describe, expect, it, vi } from "vitest";
import { createEodD1Database, type D1Settlement } from "../src/eod-d1-rest";

const options = { accountId: "a".repeat(32), databaseId: "00000000-0000-4000-8000-000000000001",
  token: "test-token", allowedDatabaseIds: ["00000000-0000-4000-8000-000000000001"] };
const result = (value: number) => ({ success: true, results: [{value}], meta: {rows_read:value, rows_written:0, size_after:8192} });

describe("public D1 REST adapter contract", () => {
  it("allows complete operator-reviewed trigger DDL only by exact match", async () => {
    const ddl="CREATE TRIGGER guard BEFORE INSERT ON sample BEGIN SELECT RAISE(ABORT,'frozen'); END; /* storage-reviewed-ddl */";
    const admission=vi.fn(async () => Object.assign(async () => undefined,{abandon:async () => undefined}));
    const fetcher=vi.fn(async (_url:RequestInfo|URL,init?:RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        sql:"CREATE TRIGGER guard BEFORE INSERT ON sample BEGIN SELECT RAISE(ABORT,'frozen'); END",params:[],
      });
      return Response.json({success:true,result:[result(1)]});
    });
    const db=createEodD1Database({...options,fetcher,admission,reviewedDdl:[ddl]});
    await db.prepare(ddl).run();
    expect(admission).toHaveBeenCalledWith([{sql:ddl,params:[]}]);
    await expect(db.prepare(ddl+" DROP TABLE sample").run()).rejects.toThrow();
    await expect(db.prepare(ddl).bind("unexpected").run()).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("preserves ordinary SQL and rejects unreviewed trigger bodies even with the DDL accounting label",async () => {
    const sql="SELECT ? AS value; /* storage-reviewed-ddl */";
    const fetcher=vi.fn(async (_url:RequestInfo|URL,init?:RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({sql,params:[1]});
      return Response.json({success:true,result:[result(1)]});
    });
    const db=createEodD1Database({...options,fetcher,reviewedDdl:["CREATE TABLE allowed(id TEXT);"]});
    await db.prepare(sql).bind(1).run();
    await expect(db.prepare("CREATE TRIGGER unreviewed BEFORE INSERT ON allowed BEGIN SELECT 1; END; /* storage-reviewed-ddl */").run()).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("sends a documented object batch with separate parameter arrays and maps ordered results", async () => {
    const settle = Object.assign(vi.fn(async () => undefined), { abandon: vi.fn(async () => undefined) }) as D1Settlement;
    const admission = vi.fn(async () => settle);
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({batch: [
        {sql:"SELECT ?1 AS value", params:[11]}, {sql:"SELECT ?1 AS value", params:[22]},
      ]});
      return Response.json({success:true, result:[result(11),result(22)]});
    });
    const db = createEodD1Database({...options, admission, fetcher});
    expect((await db.batch([db.prepare("SELECT ?1 AS value").bind(11), db.prepare("SELECT ?1 AS value").bind(22)]))
      .map((entry) => entry.results)).toEqual([[{value:11}],[{value:22}]]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(admission).toHaveBeenCalledWith([{sql:"SELECT ?1 AS value", params:[11]}, {sql:"SELECT ?1 AS value", params:[22]}]);
    expect(settle).toHaveBeenCalledWith({rowsRead:33, rowsWritten:0, sizeAfter:8192});
    expect(settle.abandon).not.toHaveBeenCalled();
  });

  it("preserves the single-query object and does not send an empty batch", async () => {
    const admission = vi.fn(async () => Object.assign(async () => undefined, {abandon:async () => undefined}));
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({sql:"SELECT 1",params:[]});
      return Response.json({success:true,result:[result(1)]});
    });
    const db = createEodD1Database({...options,admission,fetcher});
    expect(await db.batch([])).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(admission).not.toHaveBeenCalled();
    await db.prepare("SELECT 1").all();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    {sql:"SELECT ?",params:[]}, {sql:"SELECT ?1",params:[1,2]}, {sql:"SELECT ?101",params:Array(100).fill(1)},
    {sql:"SELECT :named",params:[1]}, {sql:"SELECT ?",params:[undefined]}, {sql:"SELECT ?",params:[Number.NaN]},
    {sql:"SELECT ?",params:[true]}, {sql:"SELECT 1; SELECT 2",params:[]}, {sql:"SELECT 1; -- end\nDELETE FROM eod_usage",params:[]},
    {sql:"BEGIN TRANSACTION",params:[]}, {sql:"DROP TABLE eod_usage",params:[]}, {sql:"/* comment only */",params:[]},
    {sql:"SELECT 'unterminated",params:[]}, {sql:"SELECT 1 /* unterminated",params:[]},
  ])("rejects invalid scoped SQL/bindings before quota admission or network I/O: $sql", async ({sql,params}) => {
    const fetcher = vi.fn(), admission = vi.fn();
    const db = createEodD1Database({...options,fetcher,admission});
    await expect(db.prepare(sql).bind(...params).all()).rejects.toThrow();
    expect(admission).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("ignores placeholders and semicolons inside SQL literals, identifiers and comments", async () => {
    const fetcher = vi.fn(async () => Response.json({success:true,result:[result(1)]}));
    const db = createEodD1Database({...options,fetcher});
    await db.prepare("SELECT 'O''Reilly; DROP ?2', ?1 AS \"value;?\", ?1 AS [again;?] /* ?9; */; -- trailing ?99").bind("safe; ' value").all();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("bounds UTF-8 SQL, individual values, total request size and statement count without splitting", async () => {
    const fetcher = vi.fn(), admission = vi.fn();
    const db = createEodD1Database({...options,fetcher,admission});
    await expect(db.prepare(`SELECT '${"界".repeat(30_000)}'`).all()).rejects.toThrow(/size/);
    await expect(db.prepare("SELECT ?").bind("x".repeat(2_000_001)).all()).rejects.toThrow(/value limit/);
    await expect(db.batch(Array.from({length:5}, () => db.prepare("SELECT ?").bind("x".repeat(1_700_000)))))
      .rejects.toThrow(/payload limit/);
    await expect(db.batch(Array.from({length:41}, () => db.prepare("SELECT 1")))).rejects.toThrow(/40 statements/);
    expect(fetcher).not.toHaveBeenCalled();
    expect(admission).not.toHaveBeenCalled();
  });

  it.each([
    {success:true,result:[]}, {success:true,result:[result(1),result(2)]},
    {success:true,result:[{...result(1),results:null}]}, {success:true,result:[{...result(1),meta:{rows_read:1.5,rows_written:0}}]},
    {success:true,result:[{...result(1),meta:{rows_read:1,rows_written:-1}}]},
  ])("fails closed and abandons once when response cardinality or usage is invalid", async (body) => {
    const settle = Object.assign(vi.fn(async () => undefined), {abandon:vi.fn(async () => undefined)}) as D1Settlement;
    const fetcher = vi.fn(async () => Response.json(body));
    const db = createEodD1Database({...options,fetcher,admission:async () => settle});
    await expect(db.prepare("SELECT 1").all()).rejects.toThrow(/d1-/);
    expect(settle).not.toHaveBeenCalled();
    expect(settle.abandon).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("keeps HTTP status/numeric codes but never echoes provider messages, malformed bodies or transport details", async () => {
    const privateText = "private-bound-value and Authorization: Bearer test-token";
    const attempts: Array<typeof fetch> = [
      async () => Response.json({success:false,errors:[{code:7400,message:privateText}]},{status:400}),
      async () => new Response(privateText,{status:502}),
      async () => { throw new Error(privateText); },
    ];
    const expected = ["d1-http-400: codes=7400","d1-response-invalid-json: status=502","d1-network-error"];
    for (let index=0;index<attempts.length;index++) {
      const db = createEodD1Database({...options,fetcher:attempts[index]});
      await expect(db.prepare("SELECT ?").bind(privateText).all()).rejects.toThrow(expected[index]);
    }
  });

  it.each([
    {status:400,message:"Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.",tag:"d1-quota-exhausted",daily:true},
    {status:400,message:"Your account has exceeded D1's free tier daily row write limit.",tag:"d1-quota-exhausted",daily:true},
    {status:400,message:"D1_ERROR: Exceeded maximum DB size.",tag:"d1-capacity-exhausted",daily:true},
    {status:400,message:"database or disk is full: SQLITE_FULL",tag:"d1-capacity-exhausted",daily:true},
    {status:400,message:"Your account has exceeded D1's maximum account storage limit, please contact Cloudflare to raise your limit",tag:"d1-capacity-exhausted",daily:true},
    {status:429,message:"Too many API requests",tag:"d1-api-rate-limited",daily:false},
    {status:400,message:"near private_table: syntax error",tag:"d1-http-400: codes=7500",daily:false},
  ])("preserves safe retry classification: $tag", async ({status,message,tag,daily}) => {
    const db = createEodD1Database({...options,fetcher:async () => Response.json({success:false,
      errors:[{code:7500,message:`${message} private-bound-value`}]},{status})});
    const error = await db.prepare("SELECT 1").all().then(() => null, (failure: unknown) => failure as Error);
    expect(error?.message).toContain(tag);
    expect(error?.message).not.toContain("private-bound-value");
    // This is the runner's resource-deferral classification: daily/capacity tags
    // wait until00:05UTC; ordinary API request-rate and SQL failures use15min.
    expect(/budget|quota|capacity/i.test(error!.message)).toBe(daily);
  });
});

// Fake transports need no wall-clock pacing; the limiter has its own clock-controlled tests.
vi.mock("../src/eod-rest-request-limiter", () => ({ pacedEodRestFetch: (_account: string, _token: string, fetcher: typeof fetch, url: RequestInfo | URL, init: RequestInit | (() => RequestInit)) => fetcher(url, typeof init === "function" ? init() : init) }));
