import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname,join,resolve } from "node:path";
import { describe,expect,it } from "vitest";
import { verifyStorageCapacityArtifacts } from "../scripts/storage-current-archive-context";
import { storageStartSnapshotHash } from "../scripts/storage-start-snapshot";
import type { StorageExpansionHistoryReceipt } from "../scripts/eod-population-expansion-operator";
describe("capacity continuation actual local artifacts",()=>{
 it("checks the actual SQLite bytes, backup identity and original analysis directory",async()=>{
  const base=resolve(tmpdir()),folder=mkdtempSync(join(base,"capacity-artifact-test-")),directory=join(folder,"captured");mkdirSync(directory);
  const sourceFile=join(folder,"source.sqlite"),historyFile=join(directory,"history-1.sqlite"),analysisPath=join(directory,"storage-analysis.json");
  const python=(script:string,args:string[])=>execFileSync("python",["-c",script,...args],{windowsHide:true,stdio:["ignore","pipe","pipe"]});
  try {
   python("import sqlite3,sys\nfor path in sys.argv[1:]:\n c=sqlite3.connect(path);c.execute('CREATE TABLE proof(value TEXT)');c.execute('INSERT INTO proof VALUES(?)',('original',));c.commit();c.close()",[sourceFile,historyFile]);
   writeFileSync(analysisPath,JSON.stringify({measuredAt:"2026-09-12T01:55:00Z",sourceRows:1989616}));
   const hash=(path:string)=>createHash("sha256").update(readFileSync(path)).digest("hex");
   const receipt={directory,file:"history-1.sqlite",fileHash:hash(historyFile)} as StorageExpansionHistoryReceipt;
   const input={receipt,sourceFile,analysisPath,expectedSourceSnapshotHash:storageStartSnapshotHash(sourceFile,folder)};
   expect(await verifyStorageCapacityArtifacts(input)).toEqual({historyFileHash:receipt.fileHash,analysisFileHash:hash(analysisPath)});
   await expect(verifyStorageCapacityArtifacts({...input,analysisPath:join(folder,"storage-analysis.json")})).rejects.toThrow("original-artifact-mismatch");
   await expect(verifyStorageCapacityArtifacts({...input,expectedSourceSnapshotHash:"0".repeat(64)})).rejects.toThrow("original-artifact-mismatch");
   python("import sqlite3,sys\nc=sqlite3.connect(sys.argv[1]);c.execute('INSERT INTO proof VALUES(?)',('changed',));c.commit();c.close()",[historyFile]);
   expect((await verifyStorageCapacityArtifacts(input)).historyFileHash).not.toBe(receipt.fileHash);
   expect(receipt.fileHash).not.toBe(hash(historyFile));
  } finally {
   if(dirname(resolve(folder))!==base||!resolve(folder).startsWith(join(base,"capacity-artifact-test-")))throw new Error("unsafe-test-cleanup");
   rmSync(folder,{recursive:true,force:true});
  }
 });
});
