import {describe,expect,it} from "vitest";
import {validateStorageIndexLoaderCodeTrees} from "../scripts/storage-index-loader-code-contract";
import {STORAGE_INDEX_LOADER_PREVIOUS_REVISION} from "../src/market-storage-history-index-continuation";
const paths=["worker/src/eod-runner.ts","worker/src/market-history.ts","worker/src/market-storage-acceptance.ts","worker/src/market-storage-verification.ts","package-lock.json",
  "worker/src/market-storage-history-index-recovery.ts"];
const before=paths.map((path,i)=>({path,mode:"100644",blob:String(i+1).repeat(40)}));
const oldLoader='const preserved = 1; export async function loadStorageHistoryIndexAmendment(ops,run,plan) {const text=read(plan);if(!text)return null;const recovery=read(text);if(!recovery.valid)throw new Error("invalid");return recovery.amendment;}';
const newLoader='import { loadStorageIndexLoaderContinuation } from "./market-storage-history-index-continuation"; const preserved = 1; export async function loadStorageHistoryIndexAmendment(ops,run,value) {const {bootstrapInputs,sizingHash,...plan}=value;const text=read(plan);if(!text)return loadStorageIndexLoaderContinuation(ops,run,plan);const recovery=read(text);if(!recovery.valid)throw new Error("invalid");return recovery.amendment;}';
const input=()=>({fromRevision:STORAGE_INDEX_LOADER_PREVIOUS_REVISION,codeRevision:"f".repeat(40),before,
  after:before.map(row=>row.path.endsWith("recovery.ts")?{...row,blob:"e".repeat(40)}:row),oldLoader,newLoader});
describe("R14 index-loader-only execution contract",()=>{
  it("allows the reviewed normalization prefix while retaining original validation",()=>{
    expect(validateStorageIndexLoaderCodeTrees(input())).toMatchObject({protectedFileCount:5,fromRevision:STORAGE_INDEX_LOADER_PREVIOUS_REVISION});
  });
  it.each([newLoader.replace("preserved = 1","preserved = 2"),newLoader.replace("!recovery.valid","false"),
    newLoader.replace("loadStorageIndexLoaderContinuation }","loadStorageIndexLoaderContinuation as hidden }")])("rejects original code/import weakening",newLoader=>{
    expect(()=>validateStorageIndexLoaderCodeTrees({...input(),newLoader})).toThrow();
  });
  it("rejects any reader/schema/provider change or unsupported predecessor",()=>{
    expect(()=>validateStorageIndexLoaderCodeTrees({...input(),fromRevision:"a".repeat(40)})).toThrow("revision-invalid");
    expect(()=>validateStorageIndexLoaderCodeTrees({...input(),after:input().after.map(row=>row.path.endsWith("market-history.ts")?{...row,blob:"b".repeat(40)}:row)})).toThrow("protected-dependency-changed");
  });
});
