import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import ts from "typescript";
import { STORAGE_REPAIR_EXECUTION_PREVIOUS_REVISION, type StorageRepairExecutionCodeContract } from "../src/market-storage-repair-execution";

type Entry = { path: string; mode: string; blob: string };
type Token = [number, string];
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fail(reason: string): never { throw new Error(`storage-repair-code-${reason}`); }
// Exact reviewed integration source hashes. Finalized only after the complete
// incomplete-repair quarantine branches are reviewed. Existing checkpoints,
// publications and all source/storage evidence remain unchanged by admission.
export const STORAGE_REPAIR_INTEGRATION_HASHES: Readonly<Record<string,string>> = {
  "worker/src/market-storage-repair-execution.ts": "9203c93728e9ab5b2e011b26e8ac7c3b57042341b557d5ce8428e62be5bad494",
  "worker/src/market-storage-history-index-recovery.ts": "661f74006a006e01649cd120063cd26c4964200a774c8d20b3d1d7ce8ec5a1a0",
  "worker/src/eod-runner.ts": "36851b16d274283f0cb9ab712c7e7d1f3b20b278027a76aba94ec977c8d84d7b",
  "worker/src/eod-catalog-service.ts": "845559bee0ea77ea0c9b4f4edcda99853085bbf5e172e826b1d3c51bffdb349f",
  "worker/src/eod-rollout-service.ts": "611e111e83317008d6352fcedabad5b450bc8a518a7d0bd23cb19a50d1a692e1",
  "worker/src/market-storage-acceptance.ts": "d0d3bee6cca3ba159940677df8403ee4044eaff8a6890f2b36f530132030fcdf",
  "worker/src/eod-catalog-quarantine-validation.ts": "cca5d8f73c5f3faf4afa2da6c4a0c6cd935f4aa60e255dbc524c70c335b4019e",
  "worker/src/eod-history-maintenance.ts": "3c76c8d64b8b3bd61f94bd6e268d79c650640195f15ef66f18fb5f5b224eae69",
  "worker/src/eod-history-runner.ts": "3a0d916e48de74c28325b6aa40a60406d757698212bac7eff55be6cc3842a55f",
  "worker/src/scans-page-service.ts": "22ae8b1fb7317c9b919b65ffb9a0a05310fa01e8c4d98eb20b27aa5695d3d267",
  "worker/src/pattern-scanner-service.ts": "3b56aea52f4316f2ce790dacfd7f15424875c872d8b014240ea2fd231d2b3fb5",
  "worker/src/index.ts": "bfdd076a82ef1df59162ce49747b960bffd1fa9a2ed086aad1e5fbb43bc3473c",
  "worker/scripts/continue-storage-repair-execution.ts": "49203baac98b6d8c048b32a3290a723127b7d867badbac673ed6ff23c0cd111e",
};
const INTEGRATIONS=STORAGE_REPAIR_INTEGRATION_HASHES;
const RUNNER_CONFIG_HASH="d60c882901e33eb76e26ff78c4c85e44a7c155f000cc36fe0a19eae47226bc4f";
const META = new Set(["worker/scripts/storage-repair-execution-code-contract.ts","worker/tsconfig.runner.json"]);
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

export function validateStorageRepairExecutionCodeTrees(input: { fromRevision: string; codeRevision: string;
  before: Entry[]; after: Entry[]; integrationSources: Readonly<Record<string,string>>;runnerConfig:string }): StorageRepairExecutionCodeContract {
  if (input.fromRevision !== STORAGE_REPAIR_EXECUTION_PREVIOUS_REVISION || !/^[a-f0-9]{40}$/.test(input.codeRevision)
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
  if (!["worker/src/eod-price-provider.ts","worker/src/eod-ticker-aliases.ts","worker/src/eod-price-repair.ts",
    "worker/src/market-history.ts","worker/src/market-storage-verification.ts","worker/src/eod-bar-store.ts",
    "worker/src/provider-usage.ts","worker/src/eod-budget-profile.ts","worker/src/market-storage-population-execution.ts",
    "worker/src/market-storage-atomic-manifest.ts","worker/src/market-storage-population-expansion.ts",
    "worker/src/market-storage-consumer-composite.ts","worker/src/market-storage-listing-execution.ts",
    "worker/src/eod-metrics.ts","worker/src/eod-listing-evidence.ts","worker/wrangler.toml","package-lock.json"]
    .every(path=>protectedFiles.some(row=>row.path===path))) fail("protected-manifest-incomplete");
  const fields = { version:1 as const,policy:"incomplete-repair-quarantine-contracts-v1" as const,
    fromRevision:STORAGE_REPAIR_EXECUTION_PREVIOUS_REVISION as typeof STORAGE_REPAIR_EXECUTION_PREVIOUS_REVISION,
    codeRevision:input.codeRevision,protectedFileCount:protectedFiles.length,protectedManifestHash:digest(protectedFiles),
    integrationContractHash:digest(INTEGRATIONS),reviewedChangesHash:digest(changes),beforeTreeHash:digest(input.before),afterTreeHash:digest(input.after) };
  return {...fields,evidenceHash:digest(fields)};
}
export function collectStorageRepairExecutionCodeContract(input:{root:string;fromRevision:string;codeRevision:string}):StorageRepairExecutionCodeContract {
  const git=(...args:string[])=>execFileSync("git",args,{cwd:input.root,encoding:"utf8",windowsHide:true,timeout:30_000,
    maxBuffer:32_000_000,stdio:["ignore","pipe","pipe"]});
  const tree=(revision:string)=>git("ls-tree","-r","-z",revision).split("\0").filter(Boolean).map(row=>{
    const match=/^(\d{6}) blob ([a-f0-9]{40})\t([^\0]+)$/.exec(row);if(!match)fail("tree-invalid");return{path:match[3],mode:match[1],blob:match[2]};
  });
  return validateStorageRepairExecutionCodeTrees({...input,before:tree(input.fromRevision),after:tree(input.codeRevision),
    integrationSources:Object.fromEntries(Object.keys(INTEGRATIONS).map(path=>[path,git("show",`${input.codeRevision}:${path}`)])),
    runnerConfig:git("show",`${input.codeRevision}:worker/tsconfig.runner.json`)});
}
