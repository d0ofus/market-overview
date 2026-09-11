import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { describe,expect,it } from "vitest";
import { validateStorageListingExecutionCodeTrees,STORAGE_LISTING_INTEGRATION_HASHES } from "../scripts/storage-listing-execution-code-contract";
import { STORAGE_LISTING_EXECUTION_PREVIOUS_REVISION } from "../src/market-storage-listing-execution";
const root=resolve(import.meta.dirname,"../..");
const protectedPaths=["worker/src/eod-price-provider.ts","worker/src/eod-ticker-aliases.ts","worker/src/eod-price-repair.ts",
  "worker/src/market-history.ts","worker/src/market-storage-verification.ts","worker/src/eod-bar-store.ts",
  "worker/src/provider-usage.ts","worker/src/eod-budget-profile.ts","worker/src/market-storage-population-execution.ts",
  "worker/src/market-storage-atomic-manifest.ts","worker/src/market-storage-population-expansion.ts",
  "worker/src/market-storage-consumer-composite.ts","worker/wrangler.toml","package-lock.json"];
const historical=(path:string)=>execFileSync("git",["show",`e1ca6b5579b5faa6c3c80a6a423be34c36ac1903:${path}`],{cwd:root,encoding:"utf8",windowsHide:true,stdio:["ignore","pipe","pipe"]});
const digest=(value:string)=>createHash("sha1").update(value).digest("hex");
function fixture() {
  const integrationSources=Object.fromEntries(Object.keys(STORAGE_LISTING_INTEGRATION_HASHES).map(path=>[path,historical(path)]));
  const before=protectedPaths.map(path=>({path,mode:"100644",blob:digest(path)}));
  const after=[...before,...Object.entries(integrationSources).map(([path,text])=>({path,mode:"100644",blob:digest(text)})),
    {path:"worker/tsconfig.runner.json",mode:"100644",blob:digest("runner")}];
  return {fromRevision:STORAGE_LISTING_EXECUTION_PREVIOUS_REVISION,codeRevision:"f".repeat(40),before,after,integrationSources,
    runnerConfig:historical("worker/tsconfig.runner.json")};
}
describe("reviewed listing code-only transition",()=>{
  it("pins every reviewed integration while retaining all protected price/storage dependencies",()=>{
    expect(validateStorageListingExecutionCodeTrees(fixture())).toMatchObject({version:1,policy:"optional-listing-evidence-contracts-v1",protectedFileCount:14});
  });
  it.each(["worker/src/eod-price-provider.ts","worker/src/market-storage-population-execution.ts","worker/src/market-history.ts","worker/wrangler.toml"])("rejects changed protected %s",path=>{
    const input=fixture();input.after=input.after.map(row=>row.path===path?{...row,blob:"9".repeat(40)}:row);
    expect(()=>validateStorageListingExecutionCodeTrees(input)).toThrow("protected-dependency-changed");
  });
  it("rejects changed promotion logic and unknown runtime code",()=>{
    const input=fixture();input.integrationSources["worker/src/market-storage-listing-execution.ts"]+="\nexport const bypass=true;";
    expect(()=>validateStorageListingExecutionCodeTrees(input)).toThrow("integration-source-unreviewed");
    const unknown=fixture();unknown.after.push({path:"worker/src/unreviewed.ts",mode:"100644",blob:"1".repeat(40)});
    expect(()=>validateStorageListingExecutionCodeTrees(unknown)).toThrow("protected-dependency-changed");
  });
  it("pins the exact candidate readiness correction and rejects removal of the final-pause check",()=>{
    const input=fixture(),path="worker/src/eod-runtime-candidate.ts";
    const reviewed=input.integrationSources[path];
    input.integrationSources[path]=reviewed.replace('run.error_code !== "storage-final-acceptance-required"',"false");
    expect(input.integrationSources[path]).not.toBe(reviewed);
    expect(()=>validateStorageListingExecutionCodeTrees(input)).toThrow("integration-source-unreviewed");
  });
  it("rejects executable integration files, wrong predecessor and changed compiler options",()=>{
    const input=fixture();input.after=input.after.map(row=>row.path==="worker/src/market-storage-listing-execution.ts"?{...row,mode:"100755"}:row);
    expect(()=>validateStorageListingExecutionCodeTrees(input)).toThrow("reviewed-path-invalid");
    expect(()=>validateStorageListingExecutionCodeTrees({...fixture(),fromRevision:"0".repeat(40)})).toThrow("revision-invalid");
    const config=fixture(),parsed=JSON.parse(config.runnerConfig);parsed.compilerOptions.strict=false;config.runnerConfig=JSON.stringify(parsed);
    expect(()=>validateStorageListingExecutionCodeTrees(config)).toThrow("runner-config-unreviewed");
  });
  it("accepts only semantically identical whitespace/comments in locked TypeScript",()=>{
    const input=fixture();for(const path of Object.keys(input.integrationSources))input.integrationSources[path]="// reviewed whitespace only\n"+input.integrationSources[path].replace(/\r\n/g,"\n");
    expect(validateStorageListingExecutionCodeTrees(input).protectedFileCount).toBe(14);
  });
});
