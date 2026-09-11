import { afterEach,describe,expect,it } from "vitest";
import { createSqliteD1 } from "./helpers/sqlite-d1";
import { storageFeatureCheckpointComparison,assertStorageAtomicParameters } from "../src/market-storage-atomic-manifest";
import { storagePopulationExecutionBoundary } from "../src/market-storage-population-execution";
let db:ReturnType<typeof createSqliteD1>|undefined;
afterEach(()=>{db?.dispose();db=undefined;});
describe("population atomic parameter limits",()=>{
  it("compares a3.3MB253-checkpoint manifest atomically using bounded JSON parameters and rejects a later-page race",async()=>{
    db=createSqliteD1();db.script("CREATE TABLE eod_checkpoints(run_id TEXT,chunk_key TEXT,input_hash TEXT,payload_json TEXT,updated_at TEXT,PRIMARY KEY(run_id,chunk_key)); CREATE TABLE promoted(id TEXT PRIMARY KEY);");
    const rows=Array.from({length:253},(_,i)=>({run_id:"old",chunk_key:`features:${i}`,input_hash:"a".repeat(64),payload_json:JSON.stringify({data:"x".repeat(13_000)}),updated_at:"2026-09-11T16:00:00.000Z"}));
    expect(Buffer.byteLength(JSON.stringify(rows))).toBeGreaterThan(3_300_000);
    await db.db.batch(rows.map(row=>db!.db.prepare("INSERT INTO eod_checkpoints VALUES(?,?,?,?,?)").bind(row.run_id,row.chunk_key,row.input_hash,row.payload_json,row.updated_at)));
    const compare=storageFeatureCheckpointComparison(rows,"old");
    expect(compare.params.filter((_,index)=>index%2===0)).toHaveLength(11);
    for(const value of compare.params)expect(Buffer.byteLength(String(value))).toBeLessThan(1_000_000);
    const guard={sql:`SELECT CASE WHEN(SELECT COUNT(*) FROM eod_checkpoints WHERE run_id='old')=253 ${compare.sql} THEN 1 ELSE json_extract('mismatch','$') END`,params:compare.params};
    assertStorageAtomicParameters([guard]);
    await db.db.batch([db.db.prepare(guard.sql).bind(...guard.params),db.db.prepare("INSERT INTO promoted VALUES('valid')")]);
    expect(await db.db.prepare("SELECT COUNT(*) AS count FROM promoted").first<number>("count")).toBe(1);
    await db.db.prepare("UPDATE eod_checkpoints SET payload_json='changed' WHERE run_id='old' AND chunk_key='features:251'").run();
    await expect(db.db.batch([db.db.prepare(guard.sql).bind(...guard.params),db.db.prepare("INSERT INTO promoted VALUES('invalid')")])).rejects.toThrow();
    expect(await db.db.prepare("SELECT COUNT(*) AS count FROM promoted").first<number>("count")).toBe(1);
  });
  it("rejects an indivisible large feature and any other oversized parameter before dispatch",()=>{
    expect(()=>storageFeatureCheckpointComparison([{payload_json:"x".repeat(1_000_000)}],"old")).toThrow("row-too-large");
    expect(()=>assertStorageAtomicParameters([{sql:"SELECT ?",params:["x".repeat(2_000_001)]}])).toThrow("parameter-bound");
    expect(()=>assertStorageAtomicParameters([{sql:"SELECT ?",params:Array(101).fill(null)}])).toThrow("parameter-bound");
  });
});
describe("authentic stopped bootstrap boundaries",()=>{
  const now=new Date("2026-09-11T16:00:00.000Z"),run={status:"queued" as const,stage:"bootstrap",error_code:null,next_attempt_at:now.toISOString(),updated_at:now.toISOString()};
  const row={id:"old",input_json:"{}",progress_json:"{}",updated_at:now.toISOString(),status:"retrying",mode:"active",purpose:"daily",stage:"prices",error_code:"runner-error",
    error_message:"storage-run-time-slice-complete",next_attempt_at:now.toISOString(),completed_at:null,completed_input_clock:null};
  it("supports exact price and publication time-slice outcomes",()=>{
    expect(storagePopulationExecutionBoundary(run,row,{total:253,chunk:129,symbols:3250},6319,now).kind).toBe("prices");
    expect(storagePopulationExecutionBoundary(run,{...row,stage:"publication"},{symbols:6319},6319,now).kind).toBe("publication");
    expect(()=>storagePopulationExecutionBoundary(run,{...row,stage:"publication"},{symbols:6318},6319,now)).toThrow("planned-slice-required");
  });
  it("retains an actual15-minute incomplete-publication retry without resetting its old message",()=>{
    const retry={...run,status:"retrying" as const,error_code:"storage-bootstrap-incomplete",next_attempt_at:"2026-09-11T16:15:00.000Z"};
    const eod={...row,stage:"finished",error_code:"incomplete-publication",error_message:"older preserved error",next_attempt_at:retry.next_attempt_at};
    const progress={symbols:6319,published:["overview"],catalogPublicationId:"catalog"};
    expect(storagePopulationExecutionBoundary(retry,eod,progress,6319,now)).toEqual({kind:"incomplete",resume:{status:"retrying",errorCode:"storage-bootstrap-incomplete",nextAttemptAt:retry.next_attempt_at}});
    expect(()=>storagePopulationExecutionBoundary({...retry,error_code:"storage-quota-deferred"},eod,progress,6319,now)).toThrow("planned-slice-required");
    expect(()=>storagePopulationExecutionBoundary(retry,{...eod,error_code:"resource-budget"},progress,6319,now)).toThrow("planned-slice-required");
    expect(()=>storagePopulationExecutionBoundary({...retry,next_attempt_at:"2026-09-12T00:05:00.000Z"},eod,progress,6319,now)).toThrow("planned-slice-required");
    expect(()=>storagePopulationExecutionBoundary(retry,eod,{...progress,published:Array(6).fill("duplicate")},6319,now)).toThrow("planned-slice-required");
  });
});
