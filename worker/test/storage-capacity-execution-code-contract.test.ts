import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { describe,expect,it } from "vitest";
import { validateStorageCapacityExecutionCodeTrees,STORAGE_CAPACITY_INTEGRATION_HASHES } from "../scripts/storage-capacity-execution-code-contract";
import { STORAGE_CAPACITY_EXECUTION_PREVIOUS_REVISION } from "../src/market-storage-capacity-execution";
const root=resolve(import.meta.dirname,"../..");
const protectedPaths=["worker/src/eod-price-provider.ts","worker/src/eod-ticker-aliases.ts","worker/src/eod-price-repair.ts",
  "worker/src/market-history.ts","worker/src/market-storage-verification.ts","worker/src/eod-bar-store.ts",
  "worker/src/provider-usage.ts","worker/src/eod-budget-profile.ts","worker/src/market-storage-population-execution.ts",
  "worker/src/market-storage-atomic-manifest.ts","worker/src/market-storage-population-expansion.ts",
  "worker/src/market-storage-consumer-composite.ts","worker/src/market-storage-listing-execution.ts",
  "worker/src/eod-catalog-service.ts","worker/src/market-storage-repair-execution.ts",
  "worker/src/eod-metrics.ts","worker/src/eod-listing-evidence.ts","worker/wrangler.toml","package-lock.json"];
// The completed R21 continuation validates its original reviewed source, not
// whatever daily-operation code happens to be checked out in a later release.
const historicalSources=JSON.parse(readFileSync(resolve(root,"worker/test/fixtures/capacity-code-contract-r21.json"),"utf8")) as Record<string,string>;
const historical=(path:string)=>historicalSources[path] ?? readFileSync(resolve(root,path),"utf8");
const digest=(value:string)=>createHash("sha1").update(value).digest("hex");
function fixture() {
  const integrationSources=Object.fromEntries(Object.keys(STORAGE_CAPACITY_INTEGRATION_HASHES).map(path=>[path,historical(path)]));
  const before=protectedPaths.map(path=>({path,mode:"100644",blob:digest(path)}));
  const after=[...before,...Object.entries(integrationSources).map(([path,text])=>({path,mode:"100644",blob:digest(text)})),
    {path:"worker/tsconfig.runner.json",mode:"100644",blob:digest("runner")}];
  return {fromRevision:STORAGE_CAPACITY_EXECUTION_PREVIOUS_REVISION,codeRevision:"f".repeat(40),before,after,integrationSources,
    runnerConfig:historical("worker/tsconfig.runner.json")};
}
describe("reviewed completed-capacity code continuation",()=>{
  it("pins every reviewed integration while retaining all protected price/storage dependencies",()=>{
    expect(validateStorageCapacityExecutionCodeTrees(fixture())).toMatchObject({version:1,policy:"completed-capacity-model-contracts-v1",protectedFileCount:protectedPaths.length});
  });
  it.each(["worker/src/eod-price-provider.ts","worker/src/market-storage-population-execution.ts","worker/src/market-history.ts","worker/wrangler.toml"])("rejects changed protected %s",path=>{
    const input=fixture();input.after=input.after.map(row=>row.path===path?{...row,blob:"9".repeat(40)}:row);
    expect(()=>validateStorageCapacityExecutionCodeTrees(input)).toThrow("protected-dependency-changed");
  });
  it("rejects changed promotion logic and unknown runtime code",()=>{
    const input=fixture();input.integrationSources["worker/src/market-storage-capacity-execution.ts"]+="\nexport const bypass=true;";
    expect(()=>validateStorageCapacityExecutionCodeTrees(input)).toThrow("integration-source-unreviewed");
    const unknown=fixture();unknown.after.push({path:"worker/src/unreviewed.ts",mode:"100644",blob:"1".repeat(40)});
    expect(()=>validateStorageCapacityExecutionCodeTrees(unknown)).toThrow("protected-dependency-changed");
  });
  it("pins the exact failure boundary and rejects replacing it with a broad pause",()=>{
    const input=fixture(),path="worker/src/market-storage-capacity-execution.ts";
    const reviewed=input.integrationSources[path];
    input.integrationSources[path]=reviewed.replace('run.error_code!=="storage-population-expansion-required"',"false");
    expect(input.integrationSources[path]).not.toBe(reviewed);
    expect(()=>validateStorageCapacityExecutionCodeTrees(input)).toThrow("integration-source-unreviewed");
  });
  it("rejects any unreviewed Python model byte rather than treating it as TypeScript",()=>{
    const input=fixture();input.integrationSources["worker/scripts/analyze-eod-storage.py"]+="\nUNREVIEWED_RESERVE=0\n";
    expect(()=>validateStorageCapacityExecutionCodeTrees(input)).toThrow("integration-source-unreviewed");
  });
  it("rejects an unrelated daily provider change inside the otherwise reviewed runner",()=>{
    const input=fixture(),path="worker/src/eod-runner.ts",reviewed=input.integrationSources[path];
    input.integrationSources[path]=reviewed.replace("const provider=new EodPriceProvider(env);","const provider=undefined;");
    expect(input.integrationSources[path]).not.toBe(reviewed);
    expect(()=>validateStorageCapacityExecutionCodeTrees(input)).toThrow("integration-source-unreviewed");
  });
  it("rejects executable integration files, wrong predecessor and changed compiler options",()=>{
    const input=fixture();input.after=input.after.map(row=>row.path==="worker/src/market-storage-capacity-execution.ts"?{...row,mode:"100755"}:row);
    expect(()=>validateStorageCapacityExecutionCodeTrees(input)).toThrow("reviewed-path-invalid");
    expect(()=>validateStorageCapacityExecutionCodeTrees({...fixture(),fromRevision:"0".repeat(40)})).toThrow("revision-invalid");
    const config=fixture(),parsed=JSON.parse(config.runnerConfig);parsed.compilerOptions.strict=false;config.runnerConfig=JSON.stringify(parsed);
    expect(()=>validateStorageCapacityExecutionCodeTrees(config)).toThrow("runner-config-unreviewed");
  });
  it("accepts only semantically identical whitespace/comments in locked TypeScript",()=>{
    const input=fixture();for(const path of Object.keys(input.integrationSources))if(!path.endsWith(".py"))input.integrationSources[path]="// reviewed whitespace only\n"+input.integrationSources[path].replace(/\r\n/g,"\n");
    expect(validateStorageCapacityExecutionCodeTrees(input).protectedFileCount).toBe(protectedPaths.length);
  });
});
