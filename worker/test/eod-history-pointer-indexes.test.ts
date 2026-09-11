import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { estimateEodQueries } from "../src/eod-d1-rest";
import { prepareStorageSourceFence } from "../src/market-storage-fence";
import { createSqliteD1 } from "./helpers/sqlite-d1";

// The ordinary Python D1 fixture reports returned rows, not SQLite's internal
// FK probes. Use actual EXPLAIN plans and VM instruction counts to expose the
// hidden child-table scans, without claiming VM instructions are billed reads.
const probe = String.raw`
import json, sqlite3, sys
request=json.load(sys.stdin)
db=sqlite3.connect(':memory:')
db.execute('PRAGMA foreign_keys=ON')
db.executescript(request['schema'])
n=20000
def identity(i,prior=False): return 'sip:T%05d:2026:'%i + ('a' if prior else 'b')*64
def row(key,ticker): return (key,'sip',ticker,2026,1,'gzip-json-v1','c'*64,1,'2026-09-08','2026-09-08',200,'fixture','2020-01-01','2020-01-01')
insert='INSERT INTO market_history_blocks(id,feed,ticker,calendar_year,schema_version,codec,checksum,row_count,first_date,last_date,uncompressed_bytes,payload_base64,created_at,verified_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
db.executemany(insert,[row(identity(i,prior),'T%05d'%i) for i in range(n) for prior in (False,True)])
db.executemany(insert,[row('obsolete','T00000'),row('replacement','T00000')])
db.executemany('INSERT INTO market_history_block_pointers(feed,ticker,calendar_year,block_id,previous_block_id) VALUES(?,?,?,?,?)',
 [('sip','T%05d'%i,2026,identity(i),identity(i,True)) for i in range(n)])
db.executescript(request['guards'])
def measured_delete(sql,params):
 plan=[r[3] for r in db.execute('EXPLAIN QUERY PLAN '+sql,params)]
 db.execute('SAVEPOINT probe')
 instructions=[0]
 def count(): instructions[0]+=1; return 0
 db.set_progress_handler(count,1)
 before=db.total_changes
 cursor=db.execute(sql,params)
 returned=cursor.fetchall() if cursor.description else []
 changed=db.total_changes-before
 db.set_progress_handler(None,0)
 db.execute('ROLLBACK TO probe'); db.execute('RELEASE probe')
 return {'plan':plan,'instructions':instructions[0],'changes':changed,'returned':returned}
queries=[(request['replacementDelete'],['obsolete','sip','T00000',2026,'obsolete','obsolete']),
 (request['gcDelete'],['obsolete','2026-09-11','sip','T00000',2026,'obsolete','obsolete'])]
before=[measured_delete(sql,params) for sql,params in queries]
bytes_before=db.execute('PRAGMA page_size').fetchone()[0]*db.execute('PRAGMA page_count').fetchone()[0]
db.executescript(request['migration'])
schema_after=list(db.execute("SELECT name,sql FROM sqlite_schema WHERE type='index' ORDER BY name"))
db.executescript(request['migration'])
assert list(db.execute("SELECT name,sql FROM sqlite_schema WHERE type='index' ORDER BY name"))==schema_after
after=[measured_delete(sql,params) for sql,params in queries]
bytes_after=db.execute('PRAGMA page_size').fetchone()[0]*db.execute('PRAGMA page_count').fetchone()[0]
indexes={r[1]:[c[2] for c in db.execute('PRAGMA index_info('+r[1]+')')] for r in db.execute('PRAGMA index_list(market_history_block_pointers)')}
protected=[]
for key in [identity(0),identity(0,True)]:
 try:
  db.execute('DELETE FROM market_history_blocks WHERE id=?',(key,))
  protected.append(False)
 except sqlite3.IntegrityError: protected.append(True)
pointer_params=['sip','T00000',2026,'replacement','2026-09-11T12:00:00Z',identity(0)]
prior=db.total_changes
returned=db.execute(request['promotion'],pointer_params).fetchall()
pointer_changes=db.total_changes-prior
prior=db.total_changes
db.execute(request['verified'],['2026-09-11T12:00:00Z','replacement','c'*64])
verified_changes=db.total_changes-prior
# Each of the two changed indexed FK values removes one old entry and inserts
# one new entry. WITHOUT ROWID's PK is its table, not another billed index.
secondary_indexes=[name for name in indexes if name.startswith('idx_market_history_pointers_')]
index_writes=len(secondary_indexes)*2
print(json.dumps({'rows':n,'before':before,'after':after,'indexBytes':bytes_after-bytes_before,
 'indexes':indexes,'fkEnabled':db.execute('PRAGMA foreign_keys').fetchone()[0],'protected':protected,
 'promotion':{'returned':returned,'pointerChanges':pointer_changes,'verifiedChanges':verified_changes,
 'secondaryIndexWrites':index_writes,'modeledBilledWrites':pointer_changes+verified_changes+index_writes}}))
db.close()
`;

it("indexes both FK checks for replacement and GC across 20,000 pointers while preserving constraints and write admission",async()=>{
  const history=createSqliteD1();
  try {
    history.migrate("history-migrations");
    const guards=(await prepareStorageSourceFence(history.db)).statements.map(row=>row.sql).join("\n");
    const archive=readFileSync("src/market-history.ts","utf8"),maintenance=readFileSync("src/eod-history-maintenance.ts","utf8");
    // Extract the actual repository-fixed SQL so this regression follows each
    // real caller, including GC's age predicate and DELETE RETURNING proof.
    const replacementDelete=/`(DELETE FROM market_history_blocks[^`]+)`/.exec(archive)![1];
    const gcDelete=/`(DELETE FROM market_history_blocks[^`]+)`/.exec(maintenance)![1];
    const promotion=/`(INSERT INTO market_history_block_pointers[^`]+RETURNING block_id)`/.exec(archive)![1];
    const verified="UPDATE market_history_blocks SET verified_at = ? WHERE id = ? AND checksum = ?";
    expect(archive).toContain(verified);
    const result=JSON.parse(execFileSync("python",["-c",probe],{encoding:"utf8",windowsHide:true,timeout:30_000,
      input:JSON.stringify({schema:readFileSync("history-migrations/0001_history.sql","utf8")+"\n"
        +readFileSync("history-migrations/0002_market_storage_fence.sql","utf8"),guards,
        migration:readFileSync("history-migrations/0003_history_pointer_indexes.sql","utf8"),replacementDelete,gcDelete,promotion,verified})})) as {
      rows:number;before:Array<{plan:string[];instructions:number;changes:number}>;after:Array<{plan:string[];instructions:number;changes:number}>;
      indexBytes:number;indexes:Record<string,string[]>;fkEnabled:number;protected:boolean[];
      promotion:{returned:string[][];pointerChanges:number;verifiedChanges:number;secondaryIndexWrites:number;modeledBilledWrites:number};
    };
    expect(result.rows).toBe(20_000);
    for(let i=0;i<2;i++) {
      expect(result.before[i].plan.filter(row=>row==="SCAN market_history_block_pointers")).toHaveLength(2);
      expect(result.after[i].plan.some(row=>row.includes("SCAN market_history_block_pointers"))).toBe(false);
      expect(result.after[i].plan.some(row=>row.includes("idx_market_history_pointers_block_id"))).toBe(true);
      expect(result.after[i].plan.some(row=>row.includes("idx_market_history_pointers_previous_block_id"))).toBe(true);
      expect(result.after[i].instructions).toBeLessThan(result.before[i].instructions/100);
      expect(result.after[i].changes).toBe(result.before[i].changes);
    }
    expect(result.indexBytes).toBeGreaterThan(0);
    expect(result.indexes.idx_market_history_pointers_block_id).toEqual(["block_id"]);
    expect(result.indexes.idx_market_history_pointers_previous_block_id).toEqual(["previous_block_id"]);
    expect(result.fkEnabled).toBe(1);expect(result.protected).toEqual([true,true]);
    expect(result.promotion.returned).toEqual([["replacement"]]);
    expect(result.promotion).toMatchObject({pointerChanges:3,verifiedChanges:2,secondaryIndexWrites:4,modeledBilledWrites:9});
    expect(estimateEodQueries([{sql:verified,params:[]},{sql:promotion,params:[]}]).writes)
      .toBeGreaterThanOrEqual(result.promotion.modeledBilledWrites);
  } finally {history.dispose();}
},40_000);
