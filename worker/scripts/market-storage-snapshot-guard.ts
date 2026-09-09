/** Local identity/schema guards for resumable capacity snapshots. No network. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { STORAGE_INDEXES, STORAGE_TABLES, STORAGE_TRIGGERS } from "../src/market-storage-schema";

export type SnapshotSourceIdentity = { accountId:string; sourceDatabaseId:string; runId:string };
export type SnapshotIdentity = SnapshotSourceIdentity & {
  version:1; reviewedSchemaHash:string; frozenInputHash:string;
};
const hash=(value:string) => createHash("sha256").update(value).digest("hex");
const normalize=(value:string) => value.replace(/\bIF NOT EXISTS\b/gi, "").replace(/\s+/g," ").trim().replace(/;$/, "");
const PROGRESS_SQL="CREATE TABLE _storage_snapshot_progress(name TEXT PRIMARY KEY,cursor_json TEXT,complete INTEGER NOT NULL DEFAULT 0)";
const identityPath=(file:string) => `${file}.identity.json`;

function readIdentity(file:string):SnapshotIdentity|null {
  if (!existsSync(identityPath(file))) return null;
  let value:SnapshotIdentity;
  try { value=JSON.parse(readFileSync(identityPath(file),"utf8")) as SnapshotIdentity; }
  catch { throw new Error("storage-snapshot-identity-invalid"); }
  if (!value || value.version!==1 || !/^[a-f0-9]{32}$/i.test(value.accountId)
    || !/^[a-f0-9-]{36}$/i.test(value.sourceDatabaseId) || typeof value.runId!=="string" || !value.runId
    || !/^[a-f0-9]{64}$/.test(value.reviewedSchemaHash) || !/^[a-f0-9]{64}$/.test(value.frozenInputHash)) {
    throw new Error("storage-snapshot-identity-invalid");
  }
  return value;
}

/** Check the known source before remote requests or local schema initialization. */
export function assertSnapshotFileIdentity(file:string, expected:SnapshotSourceIdentity):void {
  const existing=readIdentity(file);
  if (!existing && existsSync(file) && statSync(file).size>0) throw new Error("storage-snapshot-existing-file-has-no-identity");
  if (existing && (existing.accountId!==expected.accountId || existing.sourceDatabaseId!==expected.sourceDatabaseId
    || existing.runId!==expected.runId)) throw new Error("storage-snapshot-source-identity-changed");
}

export function snapshotIdentity(source:SnapshotSourceIdentity,inputJson:string):SnapshotIdentity {
  let input:{tickers?:unknown};
  try {input=JSON.parse(inputJson) as typeof input;} catch {throw new Error("storage-frozen-ticker-list-missing");}
  if (!input || !Array.isArray(input.tickers) || !input.tickers.length
    || input.tickers.some((ticker) => typeof ticker!=="string" || !ticker.trim())) throw new Error("storage-frozen-ticker-list-missing");
  return {...source,version:1,reviewedSchemaHash:hash(JSON.stringify([STORAGE_TABLES,STORAGE_INDEXES,STORAGE_TRIGGERS])),
    frozenInputHash:hash(inputJson)};
}

function assertLocalSchema(file:string):void {
  if (!existsSync(file) || statSync(file).size===0) return;
  const script=`import json,pathlib,sqlite3,sys
db=sqlite3.connect(pathlib.Path(sys.argv[1]).resolve().as_uri()+'?mode=ro',uri=True)
try:
 print(json.dumps([{'name':r[0],'sql':r[1]} for r in db.execute("SELECT name,sql FROM sqlite_schema WHERE sql IS NOT NULL")]))
finally:db.close()`;
  let rows:Array<{name:string;sql:string}>;
  try { rows=JSON.parse(execFileSync("python",["-c",script,file],{encoding:"utf8",windowsHide:true,maxBuffer:1024*1024})); }
  catch {throw new Error("storage-snapshot-local-schema-unreadable");}
  // An interrupted atomic initialization can leave an empty SQLite header.
  // No application rows/checkpoints exist in this recoverable state.
  if (!rows.length) return;
  const expected=new Map<string,string>([...STORAGE_TABLES,...STORAGE_INDEXES,...STORAGE_TRIGGERS]
    .map((row) => [row.name,normalize(row.sql)]));
  expected.set("_storage_snapshot_progress",normalize(PROGRESS_SQL));
  const seen=new Set<string>();
  for (const row of rows) {
    if (expected.get(row.name)!==normalize(row.sql)) throw new Error("storage-snapshot-local-schema-changed");
    seen.add(row.name);
  }
  // Initialization creates all data tables/indexes before any page checkpoint.
  // Finalization may have installed only some valid triggers before interruption.
  for (const name of [...[...STORAGE_TABLES,...STORAGE_INDEXES].map((row) => row.name),"_storage_snapshot_progress"]) {
    if (!seen.has(name)) throw new Error("storage-snapshot-local-schema-incomplete");
  }
}

/** Validate everything before touching files. Existing manifests are immutable. */
export function prepareSnapshotFiles(file:string, expected:SnapshotIdentity,inputJson:string):void {
  assertSnapshotFileIdentity(file,expected);
  const existing=readIdentity(file);
  if (existing && (existing.reviewedSchemaHash!==expected.reviewedSchemaHash || existing.frozenInputHash!==expected.frozenInputHash)) {
    throw new Error("storage-snapshot-schema-or-input-changed");
  }
  if (hash(inputJson)!==expected.frozenInputHash) throw new Error("storage-snapshot-input-hash-mismatch");
  const tickerFile=`${file}.tickers.json`;
  if (existsSync(tickerFile) && hash(readFileSync(tickerFile,"utf8"))!==expected.frozenInputHash) {
    throw new Error("storage-snapshot-ticker-manifest-changed");
  }
  assertLocalSchema(file);
  mkdirSync(dirname(file),{recursive:true});
  if (!existing) writeFileSync(identityPath(file),JSON.stringify(expected,null,2)+"\n",{flag:"wx"});
  if (!existsSync(tickerFile)) writeFileSync(tickerFile,inputJson,{flag:"wx"});
}
