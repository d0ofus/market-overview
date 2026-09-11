import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import ts from "typescript";
import {STORAGE_INDEX_LOADER_PREVIOUS_REVISION,type StorageIndexLoaderCodeContract} from "../src/market-storage-history-index-continuation";
type Entry={path:string;mode:string;blob:string};
const digest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const loaderPath="worker/src/market-storage-history-index-recovery.ts";
const reviewed=new Set([loaderPath,"worker/src/market-storage-history-index-continuation.ts","worker/scripts/continue-storage-history-indexes.ts",
  "worker/scripts/storage-index-loader-code-contract.ts","worker/tsconfig.runner.json"]);
function fail(reason:string):never{throw new Error(`storage-index-loader-continuation-code-${reason}`);}
function parse(source:string){
  const file=ts.createSourceFile("recovery.ts",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  if((file as ts.SourceFile&{parseDiagnostics?:readonly ts.Diagnostic[]}).parseDiagnostics?.length)fail("syntax-invalid");
  const printer=ts.createPrinter({removeComments:true,newLine:ts.NewLineKind.LineFeed}),print=(node:ts.Node)=>printer.printNode(ts.EmitHint.Unspecified,node,file);
  const loaders=file.statements.filter((node):node is ts.FunctionDeclaration=>ts.isFunctionDeclaration(node)&&node.name?.text==="loadStorageHistoryIndexAmendment");
  if(loaders.length!==1||!loaders[0].body)fail("loader-boundary-invalid");
  const body=loaders[0].body.statements;
  const boundary=body.findIndex(node=>ts.isVariableStatement(node)&&node.declarationList.declarations.some(row=>ts.isIdentifier(row.name)&&row.name.text==="recovery"));
  if(boundary<0)fail("loader-validation-missing");
  const permittedImport=file.statements.filter(node=>ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)
    &&node.moduleSpecifier.text==="./market-storage-history-index-continuation");
  if(permittedImport.length>1||permittedImport.some(node=>print(node)!=='import { loadStorageIndexLoaderContinuation } from "./market-storage-history-index-continuation";'))fail("bridge-import-invalid");
  return {validation:body.slice(boundary).map(print).join("\n"),outside:file.statements.filter(node=>node!==loaders[0]&&!permittedImport.includes(node)).map(print).join("\n"),
    prefix:body.slice(0,boundary).map(print).join("\n")};
}
/** R14's existing immutable-amendment validation is retained verbatim as AST.
 * Only its input normalization/bridge prefix and the separately reviewed new
 * operator protocol may change; all providers/readers/calculations stay equal. */
export function validateStorageIndexLoaderCodeTrees(input:{fromRevision:string;codeRevision:string;before:Entry[];after:Entry[];oldLoader:string;newLoader:string}):StorageIndexLoaderCodeContract {
  if(input.fromRevision!==STORAGE_INDEX_LOADER_PREVIOUS_REVISION||!/^[a-f0-9]{40}$/.test(input.codeRevision)||input.codeRevision===input.fromRevision)fail("revision-invalid");
  const maps=[input.before,input.after].map(rows=>{
    if(!rows.length||rows.length>20_000||new Set(rows.map(row=>row.path)).size!==rows.length||rows.some(row=>!/^[a-f0-9]{40}$/.test(row.blob)))fail("tree-invalid");
    return new Map(rows.map(row=>[row.path,row]));
  });
  const protectedFiles:Entry[]=[],changes=[];
  for(const path of [...new Set([...maps[0].keys(),...maps[1].keys()])].sort()){
    const old=maps[0].get(path),current=maps[1].get(path);
    if(path.startsWith("docs/")||path.startsWith("worker/test/"))continue;
    if(reviewed.has(path)){if(!current||current.mode!=="100644")fail("reviewed-path-invalid");changes.push({path,before:old?.blob??null,after:current.blob});continue;}
    if(!old||!current||old.mode!==current.mode||old.blob!==current.blob)fail("protected-dependency-changed");protectedFiles.push(old);
  }
  if(!["worker/src/eod-runner.ts","worker/src/market-history.ts","worker/src/market-storage-acceptance.ts","worker/src/market-storage-verification.ts","package-lock.json"]
    .every(path=>protectedFiles.some(row=>row.path===path)))fail("manifest-incomplete");
  const old=parse(input.oldLoader),current=parse(input.newLoader);
  if(old.outside!==current.outside||old.validation!==current.validation||old.prefix===current.prefix)fail("original-validation-changed");
  const fields={version:1 as const,policy:"index-amendment-loader-normalization-v1" as const,
    fromRevision:STORAGE_INDEX_LOADER_PREVIOUS_REVISION as typeof STORAGE_INDEX_LOADER_PREVIOUS_REVISION,codeRevision:input.codeRevision,
    protectedFileCount:protectedFiles.length,protectedManifestHash:digest(protectedFiles),loaderValidationHash:digest(old.validation),reviewedChangesHash:digest(changes),
    beforeTreeHash:digest(input.before),afterTreeHash:digest(input.after)};
  return {...fields,evidenceHash:digest(fields)};
}
export function collectStorageIndexLoaderCodeContract(input:{root:string;fromRevision:string;codeRevision:string}):StorageIndexLoaderCodeContract{
  const git=(...args:string[])=>execFileSync("git",args,{cwd:input.root,encoding:"utf8",windowsHide:true,timeout:30_000,maxBuffer:32_000_000,stdio:["ignore","pipe","pipe"]});
  const tree=(revision:string)=>git("ls-tree","-r","-z",revision).split("\0").filter(Boolean).map(row=>{const match=/^(\d{6}) blob ([a-f0-9]{40})\t([^\0]+)$/.exec(row);
    if(!match)fail("tree-invalid");return {path:match[3],mode:match[1],blob:match[2]};});
  return validateStorageIndexLoaderCodeTrees({...input,before:tree(input.fromRevision),after:tree(input.codeRevision),oldLoader:git("show",`${input.fromRevision}:${loaderPath}`),newLoader:git("show",`${input.codeRevision}:${loaderPath}`)});
}
