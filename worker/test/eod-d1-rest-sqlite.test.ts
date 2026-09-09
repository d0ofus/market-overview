import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEodAdmission, createEodD1Database, type EodSql } from "../src/eod-d1-rest";
import { storeEodPublication, type EodPublicationInput } from "../src/eod-publication-service";
import type { Env } from "../src/types";
import { createSqliteD1 } from "./helpers/sqlite-d1";

const options = { accountId: "a".repeat(32), databaseId: "00000000-0000-4000-8000-000000000001",
  token: "test-token", allowedDatabaseIds: ["00000000-0000-4000-8000-000000000001"] };

/** Independent public endpoint fixture: raw arrays are rejected just as the
 * production /query endpoint rejects them. One object batch is executed in one
 * real SQLite transaction, with each statement retaining its own bindings. */
function restGateway(storage: ReturnType<typeof createSqliteD1>) {
  const requests: EodSql[][] = [];
  const bodies: unknown[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const body: unknown = JSON.parse(String(init?.body));
    bodies.push(body);
    const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
    const input = record && (Array.isArray(record.batch) ? record.batch : typeof record.sql === "string" ? [record] : null);
    if (!input || input.some((value) => !value || typeof value !== "object"
      || typeof (value as EodSql).sql !== "string" || !Array.isArray((value as EodSql).params))) {
      return Response.json({success:false,errors:[{code:7400,message:"Expected object single/batch query"}]},{status:400});
    }
    const queries = input as EodSql[];
    requests.push(queries);
    try {
      const result = await storage.db.batch(queries.map((query) => storage.db.prepare(query.sql).bind(...query.params)));
      return Response.json({success:true,result});
    } catch {
      return Response.json({success:false,errors:[{code:7500,message:"private-server-diagnostic"}]},{status:400});
    }
  };
  return {fetcher,requests,bodies};
}

describe("public REST batches against real migrated SQLite", {timeout:20_000}, () => {
  let storage: ReturnType<typeof createSqliteD1>;
  beforeEach(() => {
    storage = createSqliteD1();
    storage.migrate("market-data-migrations"); storage.migrate("ops-migrations");
  }, 30_000);
  afterEach(() => storage.dispose());
  const publication = (): EodPublicationInput => ({scope:"overview:default", sessionDate:"2026-09-04", inputHash:"wire-input",
    methodologyVersion:"test-v1", payload:{asOfDate:"2026-09-04",status:"ready",sections:[]}, promote:true,
    revisions:[{feed:"sip",ticker:"AAA",revision:0}]});

  it("rejects the former raw-array format and accepts separate reused numbered/anonymous bindings", async () => {
    const gateway = restGateway(storage);
    const old = await gateway.fetcher("https://example.test/query", {body:JSON.stringify([{sql:"SELECT 1",params:[]},{sql:"SELECT 2",params:[]}])});
    expect(old.status).toBe(400);
    const db = createEodD1Database({...options,fetcher:gateway.fetcher});
    const text = "O'Reilly; -- ?1 [quoted]";
    const rows = await db.batch([
      db.prepare("SELECT ?1 AS first, ?1 AS repeated, ?2 AS absent").bind(text,null),
      db.prepare("SELECT ? AS second, json_extract(?,'$.text') AS document").bind(22,JSON.stringify({text})),
    ]);
    expect(rows.map((row) => row.results)).toEqual([[{first:text,repeated:text,absent:null}],[{second:22,document:text}]]);
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.bodies[1]).toHaveProperty("batch");
  });

  it("allows100 bindings per statement without combining their200 binding slots", async () => {
    const gateway = restGateway(storage), db = createEodD1Database({...options,fetcher:gateway.fetcher});
    const left = Array.from({length:100}, (_, index) => index+1), right = left.map((value) => value+1000);
    const results = await db.batch([
      db.prepare("SELECT ?1 AS first, ?100 AS last").bind(...left),
      db.prepare("SELECT ?1 AS first, ?100 AS last").bind(...right),
    ]);
    expect(results.map((result) => result.results)).toEqual([[{first:1,last:100}],[{first:1001,last:1100}]]);
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0].map((query) => query.params.length)).toEqual([100,100]);
  });

  it("executes actual Ops admission and publication promotion batches through the public envelope", async () => {
    const gateway = restGateway(storage), raw = createEodD1Database({...options,fetcher:gateway.fetcher});
    const admission = createEodAdmission(raw,"wire-run",{now:() => new Date("2026-09-08T21:00:00Z")});
    const db = createEodD1Database({...options,fetcher:gateway.fetcher,admission});
    const env = {DB:db,MARKET_DATA_DB:db} as Env;
    const first = await storeEodPublication(env,publication());
    expect(await storeEodPublication(env,publication())).toBe(first);
    await admission.flush();
    expect(await storage.db.prepare("SELECT publication_id FROM eod_publication_pointers WHERE scope='overview:default'").first())
      .toEqual({publication_id:first});
    expect(await storage.db.prepare("SELECT COUNT(*) AS count FROM eod_publications").first()).toEqual({count:1});
    expect(gateway.requests.some((batch) => batch.length===3 && batch[2].sql.includes("eod_budget_reservations"))).toBe(true);
    expect(gateway.requests.some((batch) => batch.length===2 && batch[0].sql.includes("SET status='accepted'"))).toBe(true);
    expect(gateway.bodies.every((body) => !Array.isArray(body))).toBe(true);
    expect(await storage.db.prepare("SELECT reserved_reads,reserved_writes FROM eod_usage").first()).toEqual({reserved_reads:0,reserved_writes:0});
  });

  it("rolls back acceptance when the later pointer statement fails, then safely retries the immutable candidate", async () => {
    storage.script(`CREATE TRIGGER test_reject_pointer BEFORE INSERT ON eod_publication_pointers
      BEGIN SELECT RAISE(ABORT,'private-server-diagnostic'); END;`);
    const gateway = restGateway(storage), db = createEodD1Database({...options,fetcher:gateway.fetcher});
    await expect(storeEodPublication({DB:db,MARKET_DATA_DB:db} as Env,publication())).rejects.toThrow("d1-http-400: codes=7500");
    expect(await storage.db.prepare("SELECT status,accepted_at FROM eod_publications").first()).toEqual({status:"candidate",accepted_at:null});
    expect(await storage.db.prepare("SELECT COUNT(*) AS count FROM eod_publication_pointers").first()).toEqual({count:0});
    storage.script("DROP TRIGGER test_reject_pointer;");
    const id = await storeEodPublication({DB:db,MARKET_DATA_DB:db} as Env,publication());
    expect(await storage.db.prepare("SELECT publication_id FROM eod_publication_pointers").first()).toEqual({publication_id:id});
    expect(await storage.db.prepare("SELECT COUNT(*) AS count FROM eod_publications").first()).toEqual({count:1});
  });

  it("rolls back the actual Ops credit increment when its reservation-record insert fails", async () => {
    storage.script(`CREATE TRIGGER test_reject_reservation BEFORE INSERT ON eod_budget_reservations
      BEGIN SELECT RAISE(ABORT,'private-server-diagnostic'); END;`);
    const gateway = restGateway(storage), raw = createEodD1Database({...options,fetcher:gateway.fetcher});
    const admission = createEodAdmission(raw,"wire-run",{now:() => new Date("2026-09-08T21:00:00Z")});
    await expect(admission([{sql:"SELECT 1",params:[]}])).rejects.toThrow("d1-http-400: codes=7500");
    expect(await storage.db.prepare("SELECT COUNT(*) AS count FROM eod_usage").first()).toEqual({count:0});
    expect(await storage.db.prepare("SELECT COUNT(*) AS count FROM eod_budget_reservations").first()).toEqual({count:0});
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]).toHaveLength(3);
    await admission.flush();
  });
});
