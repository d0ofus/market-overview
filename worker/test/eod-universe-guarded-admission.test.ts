import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEodAdmission, estimateEodQueries, type EodSql, type EodUsage } from "../src/eod-d1-rest";
import { resolveEodBudgetProfile } from "../src/eod-budget-profile";
import { prepareStorageSourceFence } from "../src/market-storage-fence";
import { stageAndPromoteUniverseVersion } from "../src/universe-version-service";
import type { Env } from "../src/types";
import { createSqliteD1 } from "./helpers/sqlite-d1";

const now=new Date("2026-09-11T09:30:00Z");
const members=(prefix:string,n:number)=>Array.from({length:n},(_,i)=>`${prefix}${String(i).padStart(5,"0")}`);

describe("membership admission with real indexes and capture guards",{timeout:60_000},()=>{
  let market:ReturnType<typeof createSqliteD1>,ops:ReturnType<typeof createSqliteD1>;
  beforeEach(()=>{
    market=createSqliteD1();ops=createSqliteD1();market.migrate("market-data-migrations");ops.migrate("ops-migrations");
    ops.script(`WITH RECURSIVE days(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM days WHERE n<30)
      INSERT INTO eod_account_usage(usage_date,rows_read,rows_written,sampled_at)
      SELECT date('2026-09-11','-'||n||' days'),0,0,'2026-09-11T09:30:00.000Z' FROM days;`);
  });
  afterEach(()=>{market.dispose();ops.dispose();});

  async function measured(profile:"free"|"paid") {
    const plan=await prepareStorageSourceFence(market.db);
    market.script(plan.statements.map(row=>row.sql).join("\n"));
    const indexCounts=new Map<string,number>();
    for(const table of ["universe_version_members","universe_symbols","universe_versions","universes"]) {
      const indexes=await market.db.prepare(`PRAGMA index_list('${table}')`).all<{name:string}>();
      indexCounts.set(table,indexes.results.length);
    }
    expect(indexCounts.get("universe_version_members")).toBe(2);
    expect(indexCounts.get("universe_symbols")).toBe(2);
    expect(indexCounts.get("universe_versions")).toBe(3);
    const admission=createEodAdmission(ops.db,`members-${profile}`,{profile:resolveEodBudgetProfile(profile),now:()=>now,writeCredit:500});
    const observed:Array<{queries:EodSql[];usage:EodUsage;changes:number;guardWrites:number}>=[];
    const revision=()=>market.db.prepare("SELECT revision FROM market_storage_fence WHERE id='default'").first<number>("revision");
    const execute=async (queries:EodSql[])=>{
      const before=(await revision())!,settle=await admission(queries);
      const result=await market.db.batch(queries.map(row=>market.db.prepare(row.sql).bind(...row.params)));
      const guardWrites=(await revision())!-before;
      const changes=result.reduce((sum,row)=>sum+Number(row.meta.changes),0);
      // Python SQLite's total_changes includes real business rows and actual
      // BEFORE-trigger revision writes, but excludes index maintenance. Add
      // billed index work using the migrated schema; never mistake its rowcount
      // for D1 billed writes. The live 400-row stage measured 1,600 reads/writes.
      let indexWrites=0;
      for(let i=0;i<queries.length;i++) {
        const row=queries[i],match=/^\s*(INSERT(?: OR IGNORE)? INTO|DELETE FROM|UPDATE)\s+(\w+)/.exec(row.sql);
        if(!match || !indexCounts.has(match[2]))throw new Error("Unexpected membership mutation");
        const direct=queries.length===1 ? changes-guardWrites : Number(result[i].meta.changes)/2;
        expect(Number.isSafeInteger(direct)).toBe(true);
        // A status UPDATE may remove/reinsert its one affected secondary key;
        // pointer/name updates do not change indexed columns. INSERT/DELETE
        // maintain every actual PK/secondary index in the migrated schema.
        indexWrites+=direct*(match[1]==="UPDATE" ? (match[2]==="universe_versions" ? 2 : 0) : indexCounts.get(match[2])!);
      }
      if(queries.length===5)expect(changes).toBe(guardWrites*2);
      const usage={rowsRead:4*(changes-guardWrites)+(queries.length===1 && queries[0].sql.includes("eod-universe-stage") ? 0 : queries.length*16),
        rowsWritten:changes+indexWrites,sizeAfter:100_000_000};
      observed.push({queries:queries.map(({sql,params})=>({sql,params:[...params]})),usage,changes,guardWrites});
      await settle(usage);
      return result;
    };
    const statement=(sql:string,params:unknown[]=[]):D1PreparedStatement=>({sql,params,
      bind:(...values:unknown[])=>statement(sql,values),
      first:(column?:string)=>column===undefined ? market.db.prepare(sql).bind(...params).first() : market.db.prepare(sql).bind(...params).first(column),
      all:()=>market.db.prepare(sql).bind(...params).all(),run:async()=> (await execute([{sql,params}]))[0],
    }) as unknown as D1PreparedStatement;
    const db={prepare:(sql:string)=>statement(sql),batch:(rows:D1PreparedStatement[])=>execute(rows as unknown as EodSql[])} as unknown as D1Database;
    return {env:{DB:db,MARKET_DATA_DB:db} as Env,observed,admission};
  }

  it("covers real 400-row staging/pruning and resumes without rewriting staged membership",async()=>{
    market.script(`INSERT INTO universes(id,name) VALUES('sp500-core','S&P');
      WITH RECURSIVE versions(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM versions WHERE n<5)
      INSERT INTO universe_versions(id,universe_id,source,status,created_at)
        SELECT 'old'||n,'sp500-core','test','rejected','2026-08-01' FROM versions;
      WITH RECURSIVE rows(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM rows WHERE n<399)
      INSERT INTO universe_version_members(version_id,ticker) SELECT id,printf('OLD%05d',n) FROM universe_versions,rows;`);
    const measuredDb=await measured("paid");
    const input={universeId:"sp500-core",universeName:"S&P",source:"test",tickers:members("NEW",400)};
    await expect(stageAndPromoteUniverseVersion(measuredDb.env,input)).rejects.toThrow("Rejected sp500-core");
    const memberWrites=measuredDb.observed.filter(row=>row.queries[0].sql.includes("eod-universe-stage") || row.queries[0].sql.includes("eod-universe-prune-members"));
    expect(memberWrites.filter(row=>row.queries[0].sql.includes("eod-universe-stage"))).toHaveLength(1);
    expect(memberWrites.filter(row=>row.queries[0].sql.includes("eod-universe-prune-members")).length).toBeGreaterThan(0);
    for(const row of memberWrites) {
      expect(row.changes).toBe(800);expect(row.guardWrites).toBe(400);expect(row.usage.rowsWritten).toBe(1_600);
      expect(estimateEodQueries(row.queries)).toEqual({reads:3_264,writes:1_616});
    }
    await expect(stageAndPromoteUniverseVersion(measuredDb.env,input)).rejects.toThrow("Rejected sp500-core");
    expect(measuredDb.observed.filter(row=>row.queries[0].sql.includes("eod-universe-stage"))).toHaveLength(1);
    await measuredDb.admission.flush();
  });

  it.each(["free","paid"] as const)("admits the actual 8,000-change atomic promotion under %s without expanding daily limits",async profile=>{
    market.script(`INSERT INTO universes(id,name,active_version_id) VALUES('overall-market-proxy','Overall','old');
      INSERT INTO universe_versions(id,universe_id,source,status) VALUES('old','overall-market-proxy','old','active');
      WITH RECURSIVE rows(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM rows WHERE n<3999)
      INSERT INTO universe_symbols(universe_id,ticker) SELECT 'overall-market-proxy',printf('OLD%05d',n) FROM rows;
      INSERT INTO universe_version_members(version_id,ticker) SELECT 'old',ticker FROM universe_symbols;`);
    const measuredDb=await measured(profile);
    const result=await stageAndPromoteUniverseVersion(measuredDb.env,{universeId:"overall-market-proxy",universeName:"Overall",
      source:"official",tickers:members("NEW",4_000),approveLargeChange:true});
    const promotion=measuredDb.observed.find(row=>row.queries.length===5)!;
    expect(JSON.parse(String(promotion.queries[0].params[1]))).toHaveLength(4_000);
    expect(JSON.parse(String(promotion.queries[1].params[1]))).toHaveLength(4_000);
    expect(promotion.guardWrites).toBe(8_003);
    expect(promotion.usage.rowsWritten).toBe(32_010);
    expect(estimateEodQueries(promotion.queries)).toEqual({reads:64_320,writes:32_080});
    expect(await market.db.prepare("SELECT active_version_id FROM universes WHERE id='overall-market-proxy'").first("active_version_id")).toBe(result.versionId);
    expect(await market.db.prepare("SELECT COUNT(*) AS n FROM universe_symbols WHERE ticker LIKE 'NEW%'").first("n")).toBe(4_000);
    const oversized=structuredClone(promotion.queries);
    oversized[1].params[1]=JSON.stringify(members("NEW",4_001));
    await expect(measuredDb.admission(oversized)).rejects.toThrow("promotion-too-large");
    await measuredDb.admission.flush();
    const ceiling=resolveEodBudgetProfile(profile).eodDaily.writes;
    await ops.db.prepare("UPDATE eod_usage SET rows_written=? WHERE usage_date='2026-09-11'").bind(ceiling).run();
    const blocked=createEodAdmission(ops.db,"at-ceiling",{profile:resolveEodBudgetProfile(profile),now:()=>now});
    await expect(blocked(promotion.queries)).rejects.toThrow("eod-d1-budget-exhausted");
  });
});
