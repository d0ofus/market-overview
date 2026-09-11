import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import ts from "typescript";
import type { StorageConsumerCodeContract } from "../src/market-storage-consumer-transition";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const operators = new Set(["worker/src/market-storage-consumer-transition.ts", "worker/scripts/storage-consumer-code-contract.ts",
  "worker/scripts/approve-storage-execution.ts"]);
function fail(reason: string): never { throw new Error(`storage-consumer-transition-code-${reason}`); }

/** Parse the complete module, retaining all executable code and type contracts
 * outside the future batch entry point. Only its body and one existing reader
 * export's named import can differ; no consumer or input-loader code is erased. */
export function consumerRunnerContract(source: string): { contract: string; bodyHash: string; materialReaderImportCount: number } {
  const file = ts.createSourceFile("eod-runner.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diagnostics = (file as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (diagnostics?.length) fail("runner-invalid");
  const functions = file.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "runEodBatch");
  if (functions.length !== 1 || !functions[0].body) fail("batch-boundary-invalid");
  let allowedImports = 0;
  const transformed = ts.transform(file, [(context) => (root) => ts.visitNode(root, function visit(node: ts.Node): ts.VisitResult<ts.Node> {
    if (ts.isFunctionDeclaration(node) && node === functions[0]) return ts.factory.updateFunctionDeclaration(node, node.modifiers, node.asteriskToken,
      node.name, node.typeParameters, node.parameters, node.type, ts.factory.createBlock([]));
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "./market-history"
      && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      const elements = node.importClause.namedBindings.elements.filter((element) => {
        if (element.name.text !== "marketHistoryBarsMateriallyEqual") return true;
        if (element.propertyName || element.isTypeOnly || node.importClause!.isTypeOnly) fail("reader-import-invalid");
        allowedImports++; return false;
      });
      return ts.factory.updateImportDeclaration(node, node.modifiers, ts.factory.updateImportClause(node.importClause,
        node.importClause.isTypeOnly, node.importClause.name, ts.factory.updateNamedImports(node.importClause.namedBindings, elements)),
      node.moduleSpecifier, node.attributes);
    }
    return ts.visitEachChild(node, visit, context);
  }) as ts.SourceFile]);
  try {
    if (allowedImports > 1) fail("reader-import-invalid");
    return { contract: ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printFile(transformed.transformed[0]),
      bodyHash: digest(functions[0].body.getText(file)), materialReaderImportCount: allowedImports };
  } finally { transformed.dispose(); }
}

export function validateStorageConsumerCodeTrees(input: { fromRevision: string; codeRevision: string;
  before: Array<{ path: string; mode: string; blob: string }>; after: Array<{ path: string; mode: string; blob: string }>;
  oldRunner: string; newRunner: string }): StorageConsumerCodeContract {
  if (![input.fromRevision,input.codeRevision].every((value) => /^[a-f0-9]{40}$/.test(value)) || input.fromRevision === input.codeRevision) fail("revision-invalid");
  const maps = [input.before,input.after].map((rows) => {
    if (!rows.length || rows.length > 20_000 || new Set(rows.map((row) => row.path)).size !== rows.length
      || rows.some((row) => !row.path || !/^[a-f0-9]{40}$/.test(row.blob))) fail("tree-invalid");
    return new Map(rows.map((row) => [row.path,row]));
  });
  const paths = [...new Set([...maps[0].keys(),...maps[1].keys()])].sort(), protectedFiles = [], operatorChanges = [];
  for (const path of paths) {
    const before = maps[0].get(path), after = maps[1].get(path);
    if (path.startsWith("docs/") || path.startsWith("worker/test/")) continue;
    if (operators.has(path)) { operatorChanges.push({path,before:before?.blob ?? null,after:after?.blob ?? null}); continue; }
    if (path === "worker/src/eod-runner.ts") {
      if (!before || !after || before.mode !== after.mode || before.mode !== "100644") fail("runner-tree-invalid");
      continue;
    }
    if (!before || !after || before.blob !== after.blob || before.mode !== after.mode) fail("dependency-changed");
    protectedFiles.push({path,mode:before.mode,blob:before.blob});
  }
  if (!maps[0].has("worker/src/market-storage-acceptance.ts") || !maps[0].has("worker/src/market-history.ts")
    || !maps[0].has("worker/src/eod-runner.ts") || protectedFiles.length < 3) fail("dependencies-incomplete");
  const old = consumerRunnerContract(input.oldRunner), current = consumerRunnerContract(input.newRunner);
  if (old.contract !== current.contract || old.bodyHash === current.bodyHash
    || current.materialReaderImportCount < old.materialReaderImportCount) fail("outside-bootstrap-body-changed");
  const unsigned = {version:1 as const,policy:"unchanged-consumers-bootstrap-body-v1" as const,fromRevision:input.fromRevision,
    codeRevision:input.codeRevision,protectedFileCount:protectedFiles.length,protectedManifestHash:digest(protectedFiles),
    runnerContractHash:digest(old.contract),oldBootstrapBodyHash:old.bodyHash,newBootstrapBodyHash:current.bodyHash,
    operatorChangesHash:digest(operatorChanges),beforeTreeHash:digest(input.before),afterTreeHash:digest(input.after)};
  return {...unsigned,evidenceHash:digest(unsigned)};
}

/** Actual local Git objects only. The caller independently verifies a clean
 * pushed main, ancestry, the full diff, and quiescent remote workflow ownership. */
export function collectStorageConsumerCodeContract(input: { root: string; fromRevision: string; codeRevision: string }): StorageConsumerCodeContract {
  const git = (...args: string[]) => execFileSync("git",args,{cwd:input.root,encoding:"utf8",windowsHide:true,
    timeout:30_000,maxBuffer:32_000_000,stdio:["ignore","pipe","pipe"]});
  const tree = (revision: string) => git("ls-tree","-r","-z",revision).split("\0").filter(Boolean).map((entry) => {
    const match = /^(\d{6}) blob ([a-f0-9]{40})\t([^\0]+)$/.exec(entry); if (!match) fail("tree-invalid");
    return {path:match[3],mode:match[1],blob:match[2]};
  });
  return validateStorageConsumerCodeTrees({...input,before:tree(input.fromRevision),after:tree(input.codeRevision),
    oldRunner:git("show",`${input.fromRevision}:worker/src/eod-runner.ts`),newRunner:git("show",`${input.codeRevision}:worker/src/eod-runner.ts`)});
}
