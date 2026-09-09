import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STORAGE_INDEXES, STORAGE_TABLES, STORAGE_TRIGGERS } from "../src/market-storage-schema";
import { assertSnapshotFileIdentity, prepareSnapshotFiles, snapshotIdentity } from "../scripts/market-storage-snapshot-guard";

describe("offline capacity snapshot identity and schema guards", {timeout:30_000}, () => {
  let directory:string,file:string;
  const source={accountId:"a".repeat(32),sourceDatabaseId:"11111111-1111-1111-1111-111111111111",runId:"eod:shadow:2026-09-08:daily"};
  const input=JSON.stringify({tickers:["AAA","BRK.B","MISSING"],sessionDate:"2026-09-08"});
  const identity=snapshotIdentity(source,input);
  beforeEach(() => {directory=mkdtempSync(join(tmpdir(),"market-snapshot-guard-"));file=join(directory,"source.sqlite");});
  afterEach(() => {rmSync(directory,{recursive:true,force:true});});
  const sql=(statements:string[]) => execFileSync("python",["-c",`import json,sqlite3,sys
db=sqlite3.connect(sys.argv[1])
try:
 with db:
  for s in json.load(sys.stdin):db.execute(s)
finally:db.close()`,file],{input:JSON.stringify(statements),windowsHide:true});
  const populate=(triggers=false) => sql([
    ...STORAGE_TABLES.map((table) => table.sql),...STORAGE_INDEXES.map((index) => index.sql),
    "CREATE TABLE _storage_snapshot_progress(name TEXT PRIMARY KEY,cursor_json TEXT,complete INTEGER NOT NULL DEFAULT 0)",
    ...(triggers ? STORAGE_TRIGGERS.map((trigger) => trigger.sql) : []),
    "INSERT INTO universes(id,name) VALUES('preserved','Preserved')",
  ]);

  it("creates immutable manifests and resumes a matching partial or finalized schema", () => {
    prepareSnapshotFiles(file,identity,input);
    populate();
    const before=readFileSync(file);
    const manifest=readFileSync(`${file}.identity.json`,"utf8");
    prepareSnapshotFiles(file,identity,input);
    expect(readFileSync(file)).toEqual(before);
    expect(readFileSync(`${file}.identity.json`,"utf8")).toBe(manifest);
    sql(STORAGE_TRIGGERS.map((trigger) => trigger.sql));
    expect(() => prepareSnapshotFiles(file,identity,input)).not.toThrow();
  });

  it("rejects an existing capture without identity before altering its database", () => {
    populate();
    const before=readFileSync(file);
    expect(() => assertSnapshotFileIdentity(file,source)).toThrow("existing-file-has-no-identity");
    expect(() => prepareSnapshotFiles(file,identity,input)).toThrow("existing-file-has-no-identity");
    expect(readFileSync(file)).toEqual(before);
  });

  it("rejects changed source, account, run, frozen input or reviewed schema", () => {
    prepareSnapshotFiles(file,identity,input);
    populate();
    const before=readFileSync(`${file}.identity.json`,"utf8");
    for (const changed of [
      {...source,sourceDatabaseId:"22222222-2222-2222-2222-222222222222"},
      {...source,accountId:"b".repeat(32)}, {...source,runId:"different-run"},
    ]) expect(() => assertSnapshotFileIdentity(file,changed)).toThrow("source-identity-changed");
    const changedInput=JSON.stringify({tickers:["DIFFERENT"]});
    expect(() => prepareSnapshotFiles(file,snapshotIdentity(source,changedInput),changedInput)).toThrow("schema-or-input-changed");
    expect(() => prepareSnapshotFiles(file,{...identity,reviewedSchemaHash:"0".repeat(64)},input)).toThrow("schema-or-input-changed");
    expect(readFileSync(`${file}.identity.json`,"utf8")).toBe(before);
  });

  it("rejects unexpected local DDL before initialization or ticker writes", () => {
    prepareSnapshotFiles(file,identity,input);
    populate(true);
    sql(["ALTER TABLE alpaca_daily_bars ADD COLUMN unexpected TEXT"]);
    const before=readFileSync(file);
    expect(() => prepareSnapshotFiles(file,identity,input)).toThrow("local-schema-changed");
    expect(readFileSync(file)).toEqual(before);
  });

  it("rejects a changed ticker sidecar rather than overwriting it", () => {
    prepareSnapshotFiles(file,identity,input);
    populate();
    writeFileSync(`${file}.tickers.json`,"changed");
    expect(() => prepareSnapshotFiles(file,identity,input)).toThrow("ticker-manifest-changed");
    expect(readFileSync(`${file}.tickers.json`,"utf8")).toBe("changed");
  });
});
