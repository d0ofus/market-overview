import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import ts from "typescript";
import { STORAGE_CAPACITY_EXECUTION_PREVIOUS_REVISION, type StorageCapacityExecutionCodeContract } from "../src/market-storage-capacity-execution";

type Entry = { path: string; mode: string; blob: string };
type Token = [number, string];
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fail(reason: string): never { throw new Error(`storage-capacity-code-${reason}`); }
// Exact reviewed integration source hashes. Finalized only after the complete
// completed-owner model and authenticated context branches are reviewed. Existing checkpoints,
// publications and all source/storage evidence remain unchanged by admission.
export const STORAGE_CAPACITY_INTEGRATION_HASHES: Readonly<Record<string,string>> = {
  "worker/src/market-storage-capacity-execution.ts": "9ae3cd10d89d4e17fb618c006c28f7894d9df0d2620d95c8e33e14b9958e6b3e",
  "worker/src/market-storage-history-index-recovery.ts": "4113194006fc3bf7b5bbf216b029dac5f68b21b50bffc109f64ef213d159cb2e",
  "worker/src/eod-storage-layout.ts": "fe7a792a9763c1776523ac4c019dd541a0d75d10a5c1ecc85e2f0dfc6fe67495",
  "worker/src/eod-runner.ts": "a88eb5ce89344ca36b132501a77900fd47fd608beadf8a54891e4813755ef344",
  "worker/src/eod-history-runner.ts": "fcef3697894acc42a83185596b31fb8862f892cb5b979572fb060ba11d00a753",
  "worker/src/eod-deep-history-admission.ts": "8319a0e3a6f89a64708bfc05218029c18470796030875427c40667e22651b7bc",
  "worker/src/eod-current-archive-validation.ts": "3d3c767087a6d3fe507d254ed1da7d4999f6c6e03abb4a999899cfbf6c64371b",
  "worker/src/market-storage-preflight.ts": "b2893c4fffcfa1032d0c88caf2b41f94ffff3039d7cdfa0f85efc1c7e9dbc749",
  "worker/src/market-storage-acceptance.ts": "05f203572bad680b7b26a6124b6388a2e39cf65836690e5d449abb2e67e94946",
  "worker/src/market-storage-cutover-evidence.ts": "fc452ce36efb0dda2dea60180abba00cc95516d71595ed8796f8cec21cf6fbc5",
  "worker/src/eod-storage-history-capacity.ts": "6d6b71dd5464757ac57278225439fc63c8ce56175bd3db0e9e7dacd5ee403c07",
  "worker/src/eod-storage-capacity-renewal.ts": "10be38370398e7b7df7d52c12f1e9cd12a495fbd94c338a3ecdcc993c3980cdf",
  "worker/scripts/analyze-eod-storage.py": "57414310b21946666813a8d25f31e39b8c38d1fe62b8a7803dcb43eddef7b71d",
  "worker/scripts/continue-storage-capacity-execution.ts": "85d453c16a6510183df63eb4c73452471ad198e41f2014be1b272f6742aca985",
  "worker/scripts/eod-population-expansion-operator.ts": "2c32f43c2676498a1b7958fe9b2fce11a2b6bc38bb889b7c88efd8b43c110721",
  "worker/scripts/expand-storage-population.ts": "ccbaac80a6d2459ac63d7821bdc8b6cab3723b7b5f31668d976d9db19d625a38",
  "worker/scripts/continue-storage-rollout.ts": "7876b14d542f290884b1b62883f99543a4ca4d412651fdd81d3177017abe07e2",
  "worker/scripts/renew-eod-storage-capacity.ts": "3625436cbea7c104c3b97fcf934aa38cfbeed9b3fee21bd555a50aabb46eab0c",
  "worker/scripts/storage-current-archive-context.ts": "9fc62e6be748b2eca8374b659765faee6ec5fb9c76f3a64978092e269b263e8d",
  "worker/scripts/eod-capacity-capture.ts": "48f2d055f854ac13177a08f1f446a284399d5a652d9709c0aff683b2334cf5fb",
};
const INTEGRATIONS=STORAGE_CAPACITY_INTEGRATION_HASHES;
const RUNNER_CONFIG_HASH="3ee68da52a346848e10b5f390f0a5cb1f53452d8dd58a6925873117689abd2f9";
const META = new Set(["worker/scripts/storage-capacity-execution-code-contract.ts","worker/tsconfig.runner.json"]);
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

export function validateStorageCapacityExecutionCodeTrees(input: { fromRevision: string; codeRevision: string;
  before: Entry[]; after: Entry[]; integrationSources: Readonly<Record<string,string>>;runnerConfig:string }): StorageCapacityExecutionCodeContract {
  if (input.fromRevision !== STORAGE_CAPACITY_EXECUTION_PREVIOUS_REVISION || !/^[a-f0-9]{40}$/.test(input.codeRevision)
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
    if (path.startsWith("docs/") || path.startsWith("worker/test/") || path.startsWith("worker/scripts/tests/")) continue;
    if (Object.hasOwn(INTEGRATIONS,path) || META.has(path)) {
      if (!current || current.mode !== "100644") fail("reviewed-path-invalid");
      if (Object.hasOwn(INTEGRATIONS,path) && (path.endsWith(".py") ? digest((input.integrationSources[path] ?? "").replace(/\r\n/g,"\n")) : digest(tokens(input.integrationSources[path] ?? ""))) !== INTEGRATIONS[path]) fail("integration-source-unreviewed");
      changes.push({path,before:old?.blob ?? null,after:current.blob});continue;
    }
    if (!old || !current || old.mode !== current.mode || old.blob !== current.blob) fail("protected-dependency-changed");
    protectedFiles.push(old);
  }
  if (Object.keys(INTEGRATIONS).some(path => !maps[1].has(path))) fail("integration-manifest-incomplete");
  if (!["worker/src/eod-price-provider.ts","worker/src/eod-ticker-aliases.ts","worker/src/eod-price-repair.ts",
    "worker/src/market-history.ts","worker/src/market-storage-verification.ts","worker/src/eod-bar-store.ts",
    "worker/src/provider-usage.ts","worker/src/eod-budget-profile.ts","worker/src/market-storage-population-execution.ts",
    "worker/src/market-storage-atomic-manifest.ts","worker/src/market-storage-population-expansion.ts",
    "worker/src/market-storage-consumer-composite.ts","worker/src/market-storage-listing-execution.ts",
    "worker/src/eod-catalog-service.ts","worker/src/market-storage-repair-execution.ts",
    "worker/src/eod-metrics.ts","worker/src/eod-listing-evidence.ts","worker/wrangler.toml","package-lock.json"]
    .every(path=>protectedFiles.some(row=>row.path===path))) fail("protected-manifest-incomplete");
  const fields = { version:1 as const,policy:"completed-capacity-model-contracts-v1" as const,
    fromRevision:STORAGE_CAPACITY_EXECUTION_PREVIOUS_REVISION as typeof STORAGE_CAPACITY_EXECUTION_PREVIOUS_REVISION,
    codeRevision:input.codeRevision,protectedFileCount:protectedFiles.length,protectedManifestHash:digest(protectedFiles),
    integrationContractHash:digest(INTEGRATIONS),reviewedChangesHash:digest(changes),beforeTreeHash:digest(input.before),afterTreeHash:digest(input.after) };
  return {...fields,evidenceHash:digest(fields)};
}
export function collectStorageCapacityExecutionCodeContract(input:{root:string;fromRevision:string;codeRevision:string}):StorageCapacityExecutionCodeContract {
  const git=(...args:string[])=>execFileSync("git",args,{cwd:input.root,encoding:"utf8",windowsHide:true,timeout:30_000,
    maxBuffer:32_000_000,stdio:["ignore","pipe","pipe"]});
  const tree=(revision:string)=>git("ls-tree","-r","-z",revision).split("\0").filter(Boolean).map(row=>{
    const match=/^(\d{6}) blob ([a-f0-9]{40})\t([^\0]+)$/.exec(row);if(!match)fail("tree-invalid");return{path:match[3],mode:match[1],blob:match[2]};
  });
  return validateStorageCapacityExecutionCodeTrees({...input,before:tree(input.fromRevision),after:tree(input.codeRevision),
    integrationSources:Object.fromEntries(Object.keys(INTEGRATIONS).map(path=>[path,git("show",`${input.codeRevision}:${path}`)])),
    runnerConfig:git("show",`${input.codeRevision}:worker/tsconfig.runner.json`)});
}
