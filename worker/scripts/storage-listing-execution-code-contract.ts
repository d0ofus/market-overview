import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import ts from "typescript";
import { STORAGE_LISTING_EXECUTION_PREVIOUS_REVISION, type StorageListingExecutionCodeContract } from "../src/market-storage-listing-execution";

type Entry = { path: string; mode: string; blob: string };
type Token = [number, string];
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fail(reason: string): never { throw new Error(`storage-listing-code-${reason}`); }
// Exact reviewed integration source hashes. Finalized only after the complete
// optional listing-evidence branches are reviewed. Existing no-evidence
// inputs and results remain identical; the R18 source/storage proofs stay dated.
export const STORAGE_LISTING_INTEGRATION_HASHES: Readonly<Record<string,string>> = {
  "worker/src/market-storage-listing-execution.ts": "c5c93c00e9d17a2e713066f97beeff0b134677e57c5b515bf2fdf018cbfac8c4",
  "worker/src/market-storage-history-index-recovery.ts": "165024525f039c5f9d969019df99bab4e22a6edbfdd296dd833ad515005fb8f0",
  "worker/src/eod-listing-evidence.ts": "e44bbc5586c7db31923dd35ec43b148d814db8774e8f7c790d57e7bb5ff68735",
  "worker/src/eod-runner.ts": "d5ae60eec7b7e4c5a6c5132dd9e08b892e4409fe1dc8683170e1ec9fe3192c69",
  "worker/src/eod-metrics.ts": "4639d41bee4ba4c795d0bb1f64ba65ded88a6d006eee8b6829ba64b0e9f673a5",
  "worker/src/eod-runtime-candidate.ts": "6e5728bb92cb6ed58cffee6a9930d77f55175e5e793329686ea568fee99b6959",
  "worker/src/market-storage-acceptance.ts": "137176161d32adecf87f34798bcea6ce388fc8dcb38c7aab6cd138d70a7cf569",
  "worker/src/types.ts": "5232258b91ceed68f23144da698b609615774c379f15b781d8673109e1e096bf",
  "web/types/dashboard.ts": "aa856ff80bfeb5510a5e3acce2a59f038371b0ada5f24aac4b27503c6b5c0d60",
  "worker/scripts/register-eod-listing-evidence.ts": "18bb5d7d964acd0eee1ecbfa19316175ac095fb36f74230424bbbd5bd0d6ff64",
  "worker/scripts/continue-storage-listing-execution.ts": "ef0d81d0ea9cbd7a6d261d5e8631e347995781c9f639b909b506de28172cc58b",
};
const INTEGRATIONS=STORAGE_LISTING_INTEGRATION_HASHES;
const RUNNER_CONFIG_HASH="1b7a28c66bc314249a75865b847f465270e1a78d51e6f4cb8ab04d1df96d37b9";
const META = new Set(["worker/scripts/storage-listing-execution-code-contract.ts","worker/tsconfig.runner.json"]);
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

export function validateStorageListingExecutionCodeTrees(input: { fromRevision: string; codeRevision: string;
  before: Entry[]; after: Entry[]; integrationSources: Readonly<Record<string,string>>;runnerConfig:string }): StorageListingExecutionCodeContract {
  if (input.fromRevision !== STORAGE_LISTING_EXECUTION_PREVIOUS_REVISION || !/^[a-f0-9]{40}$/.test(input.codeRevision)
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
    "worker/src/market-storage-consumer-composite.ts","worker/wrangler.toml","package-lock.json"]
    .every(path=>protectedFiles.some(row=>row.path===path))) fail("protected-manifest-incomplete");
  const fields = { version:1 as const,policy:"optional-listing-evidence-contracts-v1" as const,
    fromRevision:STORAGE_LISTING_EXECUTION_PREVIOUS_REVISION as typeof STORAGE_LISTING_EXECUTION_PREVIOUS_REVISION,
    codeRevision:input.codeRevision,protectedFileCount:protectedFiles.length,protectedManifestHash:digest(protectedFiles),
    integrationContractHash:digest(INTEGRATIONS),reviewedChangesHash:digest(changes),beforeTreeHash:digest(input.before),afterTreeHash:digest(input.after) };
  return {...fields,evidenceHash:digest(fields)};
}
export function collectStorageListingExecutionCodeContract(input:{root:string;fromRevision:string;codeRevision:string}):StorageListingExecutionCodeContract {
  const git=(...args:string[])=>execFileSync("git",args,{cwd:input.root,encoding:"utf8",windowsHide:true,timeout:30_000,
    maxBuffer:32_000_000,stdio:["ignore","pipe","pipe"]});
  const tree=(revision:string)=>git("ls-tree","-r","-z",revision).split("\0").filter(Boolean).map(row=>{
    const match=/^(\d{6}) blob ([a-f0-9]{40})\t([^\0]+)$/.exec(row);if(!match)fail("tree-invalid");return{path:match[3],mode:match[1],blob:match[2]};
  });
  return validateStorageListingExecutionCodeTrees({...input,before:tree(input.fromRevision),after:tree(input.codeRevision),
    integrationSources:Object.fromEntries(Object.keys(INTEGRATIONS).map(path=>[path,git("show",`${input.codeRevision}:${path}`)])),
    runnerConfig:git("show",`${input.codeRevision}:worker/tsconfig.runner.json`)});
}
