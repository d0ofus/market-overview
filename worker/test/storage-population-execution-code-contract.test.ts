import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { describe,expect,it } from "vitest";
import { validateStoragePopulationExecutionCodeTrees,STORAGE_POPULATION_INTEGRATION_HASHES } from "../scripts/storage-population-execution-code-contract";
import { STORAGE_POPULATION_EXECUTION_PREVIOUS_REVISION } from "../src/market-storage-population-execution";
const root=resolve(import.meta.dirname,"../..");
const protectedPaths=["worker/src/eod-price-provider.ts","worker/src/eod-ticker-aliases.ts","worker/src/eod-runner.ts","worker/src/eod-price-repair.ts",
  "worker/src/market-history.ts","worker/src/market-storage-verification.ts","worker/src/eod-metrics.ts","worker/src/eod-bar-store.ts",
  "worker/src/provider-usage.ts","worker/src/eod-budget-profile.ts","worker/wrangler.toml","package-lock.json"];
const historical=(path:string)=>execFileSync("git",["show",`bf65b3c86430ebf904cdc905fb9ccd2a0d492997:${path}`],{cwd:root,encoding:"utf8",windowsHide:true});
const digest=(value:string)=>createHash("sha1").update(value).digest("hex");
function fixture() {
  const integrationSources=Object.fromEntries(Object.keys(STORAGE_POPULATION_INTEGRATION_HASHES).map(path=>[path,historical(path)]));
  const before=protectedPaths.map(path=>({path,mode:"100644",blob:digest(path)}));
  const after=[...before,...Object.entries(integrationSources).map(([path,text])=>({path,mode:"100644",blob:digest(text)})),
    {path:"worker/tsconfig.runner.json",mode:"100644",blob:digest("runner")}];
  return {fromRevision:STORAGE_POPULATION_EXECUTION_PREVIOUS_REVISION,codeRevision:"f".repeat(40),before,after,integrationSources,
    runnerConfig:historical("worker/tsconfig.runner.json")};
}
describe("reviewed population code-only transition",()=>{
  it("pins every reviewed integration while retaining all protected price/storage dependencies",()=>{
    expect(validateStoragePopulationExecutionCodeTrees(fixture())).toMatchObject({version:1,policy:"append-only-population-contracts-v1",protectedFileCount:12});
  });
  it.each(["worker/src/eod-price-provider.ts","worker/src/eod-runner.ts","worker/src/market-history.ts","worker/wrangler.toml"])("rejects changed protected %s",path=>{
    const input=fixture();input.after=input.after.map(row=>row.path===path?{...row,blob:"9".repeat(40)}:row);
    expect(()=>validateStoragePopulationExecutionCodeTrees(input)).toThrow("protected-dependency-changed");
  });
  it("rejects changed promotion logic and unknown runtime code",()=>{
    const input=fixture();input.integrationSources["worker/src/market-storage-population-promotion.ts"]+="\nexport const bypass=true;";
    expect(()=>validateStoragePopulationExecutionCodeTrees(input)).toThrow("integration-source-unreviewed");
    const unknown=fixture();unknown.after.push({path:"worker/src/unreviewed.ts",mode:"100644",blob:"1".repeat(40)});
    expect(()=>validateStoragePopulationExecutionCodeTrees(unknown)).toThrow("protected-dependency-changed");
  });
  it("rejects executable integration files, wrong predecessor and changed compiler options",()=>{
    const input=fixture();input.after=input.after.map(row=>row.path==="worker/src/market-storage-population-promotion.ts"?{...row,mode:"100755"}:row);
    expect(()=>validateStoragePopulationExecutionCodeTrees(input)).toThrow("reviewed-path-invalid");
    expect(()=>validateStoragePopulationExecutionCodeTrees({...fixture(),fromRevision:"0".repeat(40)})).toThrow("revision-invalid");
    const config=fixture(),parsed=JSON.parse(config.runnerConfig);parsed.compilerOptions.strict=false;config.runnerConfig=JSON.stringify(parsed);
    expect(()=>validateStoragePopulationExecutionCodeTrees(config)).toThrow("runner-config-unreviewed");
  });
  it("accepts only semantically identical whitespace/comments in locked TypeScript",()=>{
    const input=fixture();for(const path of Object.keys(input.integrationSources))input.integrationSources[path]="// reviewed whitespace only\n"+input.integrationSources[path].replace(/\r\n/g,"\n");
    expect(validateStoragePopulationExecutionCodeTrees(input).protectedFileCount).toBe(12);
  });
});
