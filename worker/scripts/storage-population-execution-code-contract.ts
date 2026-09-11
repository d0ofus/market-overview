import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import ts from "typescript";
import { STORAGE_POPULATION_EXECUTION_PREVIOUS_REVISION, type StoragePopulationExecutionCodeContract } from "../src/market-storage-population-execution";

type Entry = { path: string; mode: string; blob: string };
type Token = [number, string];
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fail(reason: string): never { throw new Error(`storage-population-code-${reason}`); }
// Exact reviewed integration source hashes. Finalized only after the complete
// append-only protocol is reviewed; no provider, calculation or reader changes
// are admitted by this policy. Old R17 proofs retain their original identities.
export const STORAGE_POPULATION_INTEGRATION_HASHES: Readonly<Record<string,string>> = {
  "worker/src/market-storage-atomic-manifest.ts": "c1967ea9019ba10243e534b851a0545d524b6fcbe51c2c5372a0e127fdc2d44e",
  "worker/src/market-storage-population-execution.ts": "03cdacb0fccc56cd2718c689b2c70364df323f13a020bf9ce9239e9c54351b1f",
  "worker/src/market-storage-population-promotion.ts": "5de09560c42d059f544e85ac7e2d3c40be03f3b8a410f69322879e382f196182",
  "worker/src/market-storage-population-expansion.ts": "54ed5ca7b22ab1aa9c578b318c4364ab6d682c19cbcc60da898ce78ceb1e4403",
  "worker/src/market-storage-consumer-composite.ts": "1ac952833f9462bca18c45cbe2e23b26c72ab219bff2c9062c0fa1a2b5cade38",
  "worker/src/market-storage-history-index-recovery.ts": "81467ba7cbf3b549fd3ff1fbf516e75b2f0fd07231ab375c1dd7e13364cdf4a4",
  "worker/src/market-storage-population-plan.ts": "8550f3a93e02b3ecd7f057da9228067f1cbed0694940c62a214cb0afde90b355",
  "worker/src/market-storage-pipeline.ts": "aeefc0c49e9508448544bc174563956b21916605941ac82f5009666f3d4b36c6",
  "worker/src/market-storage-cutover-evidence.ts": "5b300062e75aafcd2f58bef810f793a5bebc5a262ee5416ad94e4aa2bb76e154",
  "worker/src/eod-storage-history-capacity.ts": "9b665c980fafb322c675dd3e00544a74866b63a4d4604306604bf30a27f3a684",
  "worker/scripts/market-storage-runner.ts": "5b781d5cf8ee4adbbf3f6fdb015af55005b7efec6109d823c979fb33401ff181",
  "worker/scripts/prepare-eod-runtime-candidate.ts": "67973e64f538734d778fe33e361df8aab2bee7b3fc32ae985e96402cc19817b5",
  "worker/scripts/continue-storage-population-execution.ts": "aee8e4eaac597421e20c65ff900b35515849ad66b5b1817f6933842e94d8c1f3",
  "worker/scripts/eod-population-expansion-operator.ts": "075ce00d5e3b25baf2326ef6c0d67a666df0833e431baac1792eb31a1b130f4a",
  "worker/scripts/expand-storage-population.ts": "096c3d4e6c066d493c2539032273a66ccfac239d3ba031bf34b76b9afc93cd51",
};
const INTEGRATIONS=STORAGE_POPULATION_INTEGRATION_HASHES;
const RUNNER_CONFIG_HASH="76b24ed77ea066dbf92f3472b2d21ec3c4120606117fc167b7b92b9116293179";
const META = new Set(["worker/scripts/storage-population-execution-code-contract.ts","worker/tsconfig.runner.json"]);
function source(value: string): ts.SourceFile {
  const file = ts.createSourceFile("contract.ts", value, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if ((file as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length) fail("syntax-invalid");
  return file;
}
function tokens(value: string): Token[] {
  const file = source(value), result: Token[] = [];
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.EndOfFileToken
      || (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode)) return;
    const children = node.getChildren(file);
    // Contextual keyword token kinds (e.g. .get/.set) differ between a parsed
    // member expression and a standalone fragment. Exact token text is stable.
    if (!children.length) { const text = node.getText(file).replace(/\r\n/g, "\n"); if (text) result.push([0, text]); }
    else children.forEach(visit);
  };
  visit(file);
  return result;
}

export function validateStoragePopulationExecutionCodeTrees(input: { fromRevision: string; codeRevision: string;
  before: Entry[]; after: Entry[]; integrationSources: Readonly<Record<string,string>>;runnerConfig:string }): StoragePopulationExecutionCodeContract {
  if (input.fromRevision !== STORAGE_POPULATION_EXECUTION_PREVIOUS_REVISION || !/^[a-f0-9]{40}$/.test(input.codeRevision)
    || input.codeRevision === input.fromRevision) fail("revision-invalid");
  let config:unknown;try{config=JSON.parse(input.runnerConfig);}catch{fail("runner-config-invalid");}
  if(digest(config)!==RUNNER_CONFIG_HASH)fail("runner-config-unreviewed");
  const maps = [input.before, input.after].map(rows => {
    if (!rows.length || rows.length > 20_000 || new Set(rows.map(row => row.path)).size !== rows.length
      || rows.some(row => !/^[a-f0-9]{40}$/.test(row.blob))) fail("tree-invalid");
    return new Map(rows.map(row => [row.path, row]));
  });
  const protectedFiles: Entry[] = [], changes: Array<{path:string;before:string|null;after:string}> = [];
  for (const path of [...new Set([...maps[0].keys(), ...maps[1].keys()])].sort()) {
    const old = maps[0].get(path), current = maps[1].get(path);
    if (path.startsWith("docs/") || path.startsWith("worker/test/")) continue;
    if (Object.hasOwn(INTEGRATIONS,path) || META.has(path)) {
      if (!current || current.mode !== "100644") fail("reviewed-path-invalid");
      if (Object.hasOwn(INTEGRATIONS,path) && digest(tokens(input.integrationSources[path] ?? "")) !== INTEGRATIONS[path]) fail("integration-source-unreviewed");
      changes.push({path,before:old?.blob ?? null,after:current.blob});continue;
    }
    if (!old || !current || old.mode !== current.mode || old.blob !== current.blob) fail("protected-dependency-changed");
    protectedFiles.push(old);
  }
  if (Object.keys(INTEGRATIONS).some(path => !maps[1].has(path))) fail("integration-manifest-incomplete");
  if (!["worker/src/eod-price-provider.ts","worker/src/eod-ticker-aliases.ts","worker/src/eod-runner.ts","worker/src/eod-price-repair.ts",
    "worker/src/market-history.ts","worker/src/market-storage-verification.ts","worker/src/eod-metrics.ts","worker/src/eod-bar-store.ts",
    "worker/src/provider-usage.ts","worker/src/eod-budget-profile.ts","worker/wrangler.toml","package-lock.json"]
    .every(path=>protectedFiles.some(row=>row.path===path))) fail("protected-manifest-incomplete");
  const fields = { version:1 as const,policy:"append-only-population-contracts-v1" as const,
    fromRevision:STORAGE_POPULATION_EXECUTION_PREVIOUS_REVISION as typeof STORAGE_POPULATION_EXECUTION_PREVIOUS_REVISION,
    codeRevision:input.codeRevision,protectedFileCount:protectedFiles.length,protectedManifestHash:digest(protectedFiles),
    integrationContractHash:digest(INTEGRATIONS),reviewedChangesHash:digest(changes),beforeTreeHash:digest(input.before),afterTreeHash:digest(input.after) };
  return {...fields,evidenceHash:digest(fields)};
}
export function collectStoragePopulationExecutionCodeContract(input:{root:string;fromRevision:string;codeRevision:string}):StoragePopulationExecutionCodeContract {
  const git=(...args:string[])=>execFileSync("git",args,{cwd:input.root,encoding:"utf8",windowsHide:true,timeout:30_000,
    maxBuffer:32_000_000,stdio:["ignore","pipe","pipe"]});
  const tree=(revision:string)=>git("ls-tree","-r","-z",revision).split("\0").filter(Boolean).map(row=>{
    const match=/^(\d{6}) blob ([a-f0-9]{40})\t([^\0]+)$/.exec(row);if(!match)fail("tree-invalid");return{path:match[3],mode:match[1],blob:match[2]};
  });
  return validateStoragePopulationExecutionCodeTrees({...input,before:tree(input.fromRevision),after:tree(input.codeRevision),
    integrationSources:Object.fromEntries(Object.keys(INTEGRATIONS).map(path=>[path,git("show",`${input.codeRevision}:${path}`)])),
    runnerConfig:git("show",`${input.codeRevision}:worker/tsconfig.runner.json`)});
}
