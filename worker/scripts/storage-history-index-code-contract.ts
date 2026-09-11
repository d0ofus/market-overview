import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import ts from "typescript";
import { STORAGE_HISTORY_INDEX_RECOVERY_FROM_REVISION, type StorageHistoryIndexCodeContract } from "../src/market-storage-history-index-recovery";

const digest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const reviewed=new Set([
  "worker/history-migrations/0003_history_pointer_indexes.sql",
  "worker/scripts/analyze-eod-storage.py",
  "worker/scripts/storage-history-index-code-contract.ts",
  "worker/scripts/recover-storage-history-indexes.ts",
  "worker/src/market-storage-history-index-recovery.ts",
  "worker/src/market-storage-verification.ts",
  "worker/src/market-storage-pipeline.ts",
  "worker/src/eod-d1-rest.ts",
  "worker/tsconfig.runner.json",
]);
type TreeEntry={path:string;mode:string;blob:string};
function fail(reason:string):never {throw new Error(`storage-history-index-recovery-code-${reason}`);}
function declarations(source:string):Map<string,string> {
  const file=ts.createSourceFile("module.ts",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  if((file as ts.SourceFile & {parseDiagnostics?:readonly ts.Diagnostic[]}).parseDiagnostics?.length)fail("parse-invalid");
  const printer=ts.createPrinter({removeComments:true,newLine:ts.NewLineKind.LineFeed}),result=new Map<string,string>();
  for(const node of file.statements) {
    const printed=printer.printNode(ts.EmitHint.Unspecified,node,file);
    if(ts.isFunctionDeclaration(node)&&node.name)result.set(`function:${node.name.text}`,printed);
    else if(ts.isTypeAliasDeclaration(node)||ts.isInterfaceDeclaration(node)||ts.isClassDeclaration(node))result.set(`type:${node.name?.text}`,printed);
    else if(ts.isVariableStatement(node))result.set(`variable:${node.declarationList.declarations.map(value=>value.name.getText(file)).join(",")}`,printed);
    else result.set(`statement:${printed}`,printed);
  }
  return result;
}
/** Every price/provider/input/reader/calculation module, original migration and
 * dependency lock remains byte-identical. Only this reviewed recovery protocol,
 * its orchestration hook, bounded DDL accounting and physical sizing oracle may
 * differ. Existing verification/copy functions are also syntax-identical; the
 * separately reviewed history schema validator is the sole existing exception. */
export function validateStorageHistoryIndexCodeTrees(input:{fromRevision:string;codeRevision:string;before:TreeEntry[];after:TreeEntry[];
  migrationSql:string;oldVerification:string;newVerification:string}):StorageHistoryIndexCodeContract {
  if(input.fromRevision!==STORAGE_HISTORY_INDEX_RECOVERY_FROM_REVISION || !/^[a-f0-9]{40}$/.test(input.codeRevision)||input.codeRevision===input.fromRevision)fail("revision-invalid");
  const maps=[input.before,input.after].map(rows=>{
    if(!rows.length||rows.length>20_000||new Set(rows.map(row=>row.path)).size!==rows.length||rows.some(row=>row.mode!=="100644"&&row.mode!=="100755"||!/^[a-f0-9]{40}$/.test(row.blob)))fail("tree-invalid");
    return new Map(rows.map(row=>[row.path,row]));
  });
  const protectedFiles:TreeEntry[]=[],changes=[];
  for(const path of [...new Set([...maps[0].keys(),...maps[1].keys()])].sort()) {
    const old=maps[0].get(path),current=maps[1].get(path);
    if(path.startsWith("docs/")||path.startsWith("worker/test/")||path==="worker/scripts/tests/test_analyze_eod_storage.py")continue;
    if(reviewed.has(path)) {
      if(!current||current.mode!=="100644")fail("reviewed-file-missing");
      changes.push({path,before:old?.blob??null,after:current.blob});continue;
    }
    if(!old||!current||old.blob!==current.blob||old.mode!==current.mode)fail("consumer-dependency-changed");
    protectedFiles.push(old);
  }
  if(!["worker/src/eod-runner.ts","worker/src/market-history.ts","worker/src/market-storage-acceptance.ts","package-lock.json"]
    .every(path=>protectedFiles.some(row=>row.path===path)))fail("dependency-manifest-incomplete");
  const sql=input.migrationSql.replace(/--[^\n]*/g,"").replace(/\s+/g,"").replace(/IFNOTEXISTS/gi,"");
  const expected="CREATEINDEXidx_market_history_pointers_block_idONmarket_history_block_pointers(block_id);CREATEINDEXidx_market_history_pointers_previous_block_idONmarket_history_block_pointers(previous_block_id);";
  if(sql!==expected || maps[0].has("worker/history-migrations/0003_history_pointer_indexes.sql"))fail("migration-not-exact-index-pair");
  const old=declarations(input.oldVerification),current=declarations(input.newVerification);
  for(const [name,body] of old)if(name!=="function:assertReviewedStorageHistorySchema"&&current.get(name)!==body)fail("original-verification-function-changed");
  const fields={version:1 as const,policy:"history-index-only-bootstrap-recovery-v1" as const,fromRevision:STORAGE_HISTORY_INDEX_RECOVERY_FROM_REVISION as typeof STORAGE_HISTORY_INDEX_RECOVERY_FROM_REVISION,
    codeRevision:input.codeRevision,protectedFileCount:protectedFiles.length,protectedManifestHash:digest(protectedFiles),reviewedChangesHash:digest(changes),
    beforeTreeHash:digest(input.before),afterTreeHash:digest(input.after)};
  return {...fields,evidenceHash:digest(fields)};
}
export function collectStorageHistoryIndexCodeContract(input:{root:string;fromRevision:string;codeRevision:string}):StorageHistoryIndexCodeContract {
  const git=(...args:string[])=>execFileSync("git",args,{cwd:input.root,encoding:"utf8",windowsHide:true,timeout:30_000,maxBuffer:32_000_000,stdio:["ignore","pipe","pipe"]});
  const tree=(revision:string)=>git("ls-tree","-r","-z",revision).split("\0").filter(Boolean).map(entry=>{
    const match=/^(\d{6}) blob ([a-f0-9]{40})\t([^\0]+)$/.exec(entry);if(!match)fail("tree-invalid");return {path:match[3],mode:match[1],blob:match[2]};});
  return validateStorageHistoryIndexCodeTrees({...input,before:tree(input.fromRevision),after:tree(input.codeRevision),
    migrationSql:git("show",`${input.codeRevision}:worker/history-migrations/0003_history_pointer_indexes.sql`),
    oldVerification:git("show",`${input.fromRevision}:worker/src/market-storage-verification.ts`),newVerification:git("show",`${input.codeRevision}:worker/src/market-storage-verification.ts`)});
}
