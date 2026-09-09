/** Read-only, quota-metered logical snapshot for offline capacity measurement.
 * Local checkpoints are analysis inputs only; production history never depends
 * on this file, an Actions artifact, or cache. No source freeze or deletion. */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createEodAdmission, createEodD1Database } from "../src/eod-d1-rest";
import { reconcileEodAccountUsage } from "../src/eod-account-usage";
import { STORAGE_TABLES, STORAGE_INDEXES, STORAGE_TRIGGERS } from "../src/market-storage-schema";
import { readStoragePage, storageRowKey, type StorageCell } from "../src/market-storage-pages";
import { assertReviewedStorageSchema } from "../src/market-storage-copy";
import { assertSnapshotFileIdentity, prepareSnapshotFiles, snapshotIdentity } from "./market-storage-snapshot-guard";

const bridge=String.raw`import json,sqlite3,sys
r=json.load(sys.stdin)
db=sqlite3.connect(sys.argv[1]);db.row_factory=sqlite3.Row
try:
 with db:
  if r['action']=='init':db.execute('BEGIN IMMEDIATE')
  db.execute('CREATE TABLE IF NOT EXISTS _storage_snapshot_progress(name TEXT PRIMARY KEY,cursor_json TEXT,complete INTEGER NOT NULL DEFAULT 0)')
  if r['action']=='init':
   for s in r['schema']:db.execute(s.replace('CREATE TABLE ','CREATE TABLE IF NOT EXISTS ',1).replace('CREATE INDEX ','CREATE INDEX IF NOT EXISTS ',1))
  elif r['action']=='page':
   q=lambda s:'"'+s+'"'
   sql='INSERT OR REPLACE INTO '+q(r['name'])+'('+','.join(map(q,r['columns']))+') VALUES ('+','.join('?' for _ in r['columns'])+')'
   db.executemany(sql,[[row[c] for c in r['columns']] for row in r['rows']])
   db.execute('INSERT INTO _storage_snapshot_progress(name,cursor_json,complete) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET cursor_json=excluded.cursor_json,complete=excluded.complete',(r['name'],json.dumps(r['cursor']),int(r['complete'])))
  elif r['action']=='finalize':
   for s in r['triggers']:db.execute(s.replace('CREATE TRIGGER ','CREATE TRIGGER IF NOT EXISTS ',1))
  elif r['action']=='state':
   row=db.execute('SELECT cursor_json,complete FROM _storage_snapshot_progress WHERE name=?',(r['name'],)).fetchone()
   print(json.dumps({'cursor':json.loads(row['cursor_json']),'complete':bool(row['complete'])} if row else {'cursor':None,'complete':False}))
finally:db.close()
`;
function required(name:string):string { const value=process.env[name]?.trim(); if(!value) throw new Error(`Missing ${name}`);return value; }
async function main():Promise<void> {
  const accountId=required("CLOUDFLARE_ACCOUNT_ID"),token=required("CLOUDFLARE_EOD_D1_TOKEN");
  const source=required("EOD_MARKET_DATABASE_ID"),ops=required("EOD_OPS_DATABASE_ID");
  if (source===ops) throw new Error("storage-snapshot-source-and-ops-must-differ");
  const runId=required("EOD_SNAPSHOT_RUN_ID");
  const file=resolve(required("STORAGE_SNAPSHOT_PATH"));
  if (!file.endsWith(".sqlite")) throw new Error("Snapshot path must end in .sqlite");
  assertSnapshotFileIdentity(file,{accountId,sourceDatabaseId:source,runId});
  const local=(input:unknown) => execFileSync("python",["-c",bridge,file],{
    input:JSON.stringify(input),encoding:"utf8",windowsHide:true,maxBuffer:32*1024*1024,
  }).trim();
  const allowedDatabaseIds=[source,ops];
  const rawOps=createEodD1Database({accountId,token,databaseId:ops,allowedDatabaseIds});
  const admission=createEodAdmission(rawOps,"market-storage:capacity-snapshot",{writeCredit:200,
    reconcileAccountUsage:() => reconcileEodAccountUsage({accountId,token:process.env.CLOUDFLARE_EOD_ANALYTICS_TOKEN || token,ops:rawOps})});
  const db=createEodD1Database({accountId,token,databaseId:source,allowedDatabaseIds,admission});
  const meteredOps=createEodD1Database({accountId,token,databaseId:ops,allowedDatabaseIds,admission});
  let complete=false,rows=0,captureOpened=false;
  try {
    const run=await meteredOps.prepare("SELECT input_json FROM eod_runs WHERE id=?").bind(runId).first<{input_json:string}>();
    if (!run) throw new Error("storage-frozen-ticker-list-missing");
    await assertReviewedStorageSchema(db);
    prepareSnapshotFiles(file,snapshotIdentity({accountId,sourceDatabaseId:source,runId},run.input_json),run.input_json);
    local({action:"init",schema:[...STORAGE_TABLES.map((table) => table.sql),...STORAGE_INDEXES.map((index) => index.sql)]});
    captureOpened=true;
    for (const table of STORAGE_TABLES) {
      const state=JSON.parse(local({action:"state",name:table.name})) as {cursor:StorageCell[]|null;complete:boolean};
      if (state.complete) continue;
      let cursor=state.cursor;
      for (;;) {
        const page=await readStoragePage(db,table,cursor);
        if (page.length) cursor=storageRowKey(table,page.at(-1)!);
        local({action:"page",name:table.name,columns:table.columns,rows:page,cursor,complete:page.length<250});
        rows+=page.length;
        if (page.length<250) break;
        if (rows%25_000===0) console.log(JSON.stringify({status:"snapshot-reading",rowsThisAttempt:rows,table:table.name}));
      }
      console.log(JSON.stringify({status:"snapshot-table-complete",table:table.name,rowsThisAttempt:rows}));
    }
    local({action:"finalize",triggers:STORAGE_TRIGGERS.map((trigger) => trigger.sql)});
    complete=true;
  } finally {
    try { await admission.flush(); }
    finally {
      if (captureOpened) writeFileSync(`${file}.metadata.json`,JSON.stringify({complete,sourceDatabaseId:source,finishedAt:new Date().toISOString(),
        purpose:"capacity-estimate",consistentFrozenCapture:false,cutoverEvidence:false,rowsThisAttempt:rows},null,2));
    }
  }
  console.log(JSON.stringify({status:"snapshot-complete",rowsThisAttempt:rows,consistentFrozenCapture:false}));
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main().catch((error:unknown) => {console.error(error instanceof Error ? error.message.slice(0,300) : "storage-snapshot-failed");process.exitCode=1;});
}
