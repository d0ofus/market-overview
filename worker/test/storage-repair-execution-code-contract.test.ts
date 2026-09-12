import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { describe,expect,it } from "vitest";
import { validateStorageRepairExecutionCodeTrees,STORAGE_REPAIR_INTEGRATION_HASHES } from "../scripts/storage-repair-execution-code-contract";
import { STORAGE_REPAIR_EXECUTION_PREVIOUS_REVISION } from "../src/market-storage-repair-execution";
const root=resolve(import.meta.dirname,"../..");
const protectedPaths=["worker/src/eod-price-provider.ts","worker/src/eod-ticker-aliases.ts","worker/src/eod-price-repair.ts",
  "worker/src/market-history.ts","worker/src/market-storage-verification.ts","worker/src/eod-bar-store.ts",
  "worker/src/provider-usage.ts","worker/src/eod-budget-profile.ts","worker/src/market-storage-population-execution.ts",
  "worker/src/market-storage-atomic-manifest.ts","worker/src/market-storage-population-expansion.ts",
  "worker/src/market-storage-consumer-composite.ts","worker/src/market-storage-listing-execution.ts",
  "worker/src/eod-metrics.ts","worker/src/eod-listing-evidence.ts","worker/wrangler.toml","package-lock.json"];
// Exact reviewed R20 source, kept locally so shallow/offline checkouts exercise
// the historical contract without fetching Git objects or today's implementation.
const frozen=JSON.parse(readFileSync(resolve(root,"worker/test/fixtures/repair-code-contract-r20.json"),"utf8")) as {version:number;revision:string;sources:Record<string,string>};
if(frozen.version!==1||frozen.revision!=="e52602a8a610711bff18426793b54623aadfdffa")throw new Error("invalid-frozen-repair-contract");
const historical=(path:string)=>{const source=frozen.sources[path];if(typeof source!=="string")throw new Error("missing-frozen-repair-source");return source;};
const digest=(value:string)=>createHash("sha1").update(value).digest("hex");
function fixture() {
  const integrationSources=Object.fromEntries(Object.keys(STORAGE_REPAIR_INTEGRATION_HASHES).map(path=>[path,historical(path)]));
  const before=protectedPaths.map(path=>({path,mode:"100644",blob:digest(path)}));
  const after=[...before,...Object.entries(integrationSources).map(([path,text])=>({path,mode:"100644",blob:digest(text)})),
    {path:"worker/tsconfig.runner.json",mode:"100644",blob:digest("runner")}];
  return {fromRevision:STORAGE_REPAIR_EXECUTION_PREVIOUS_REVISION,codeRevision:"f".repeat(40),before,after,integrationSources,
    runnerConfig:historical("worker/tsconfig.runner.json")};
}
describe("reviewed incomplete-repair code continuation",()=>{
  it("pins every reviewed integration while retaining all protected price/storage dependencies",()=>{
    expect(validateStorageRepairExecutionCodeTrees(fixture())).toMatchObject({version:1,policy:"incomplete-repair-quarantine-contracts-v1",protectedFileCount:protectedPaths.length});
  });
  it.each(["worker/src/eod-price-provider.ts","worker/src/market-storage-population-execution.ts","worker/src/market-history.ts","worker/wrangler.toml"])("rejects changed protected %s",path=>{
    const input=fixture();input.after=input.after.map(row=>row.path===path?{...row,blob:"9".repeat(40)}:row);
    expect(()=>validateStorageRepairExecutionCodeTrees(input)).toThrow("protected-dependency-changed");
  });
  it("rejects changed promotion logic and unknown runtime code",()=>{
    const input=fixture();input.integrationSources["worker/src/market-storage-repair-execution.ts"]+="\nexport const bypass=true;";
    expect(()=>validateStorageRepairExecutionCodeTrees(input)).toThrow("integration-source-unreviewed");
    const unknown=fixture();unknown.after.push({path:"worker/src/unreviewed.ts",mode:"100644",blob:"1".repeat(40)});
    expect(()=>validateStorageRepairExecutionCodeTrees(unknown)).toThrow("protected-dependency-changed");
  });
  it("pins the exact failure boundary and rejects replacing it with a broad pause",()=>{
    const input=fixture(),path="worker/src/market-storage-repair-execution.ts";
    const reviewed=input.integrationSources[path];
    input.integrationSources[path]=reviewed.replace('run.error_code!=="storage-copy-verification-failed"',"false");
    expect(input.integrationSources[path]).not.toBe(reviewed);
    expect(()=>validateStorageRepairExecutionCodeTrees(input)).toThrow("integration-source-unreviewed");
  });
  it("rejects executable integration files, wrong predecessor and changed compiler options",()=>{
    const input=fixture();input.after=input.after.map(row=>row.path==="worker/src/market-storage-repair-execution.ts"?{...row,mode:"100755"}:row);
    expect(()=>validateStorageRepairExecutionCodeTrees(input)).toThrow("reviewed-path-invalid");
    expect(()=>validateStorageRepairExecutionCodeTrees({...fixture(),fromRevision:"0".repeat(40)})).toThrow("revision-invalid");
    const config=fixture(),parsed=JSON.parse(config.runnerConfig);parsed.compilerOptions.strict=false;config.runnerConfig=JSON.stringify(parsed);
    expect(()=>validateStorageRepairExecutionCodeTrees(config)).toThrow("runner-config-unreviewed");
  });
  it("accepts only semantically identical whitespace/comments in locked TypeScript",()=>{
    const input=fixture();for(const path of Object.keys(input.integrationSources))input.integrationSources[path]="// reviewed whitespace only\n"+input.integrationSources[path].replace(/\r\n/g,"\n");
    expect(validateStorageRepairExecutionCodeTrees(input).protectedFileCount).toBe(protectedPaths.length);
  });
});
