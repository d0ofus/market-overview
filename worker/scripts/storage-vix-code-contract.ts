import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import ts from "typescript";
import { STORAGE_VIX_PREVIOUS_REVISION, type StorageVixCodeContract } from "../src/market-storage-vix-continuation";

type Entry = { path: string; mode: string; blob: string };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const providerPath = "worker/src/eod-price-provider.ts", loaderPath = "worker/src/market-storage-history-index-recovery.ts";
const reviewed = new Set([providerPath, loaderPath, "worker/src/market-storage-vix-continuation.ts",
  "worker/scripts/storage-vix-code-contract.ts", "worker/scripts/continue-storage-vix.ts", "worker/tsconfig.runner.json"]);
function fail(reason: string): never { throw new Error(`storage-vix-continuation-code-${reason}`); }
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
function source(value: string): ts.SourceFile {
  const file = ts.createSourceFile("contract.ts", value, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if ((file as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length) fail("syntax-invalid");
  return file;
}
const print = (file: ts.SourceFile) => printer.printFile(file);

/** Construct the sole approved provider delta from the actual R15 AST. Every
 * other token with runtime meaning must equal the reviewed predecessor. */
function correctedProvider(value: string): string {
  const file = source(value), expected = new Set(["VIX", "XOI", "XAU", "XNG", "OSX", "BKX", "INSR"]);
  let mapCount = 0, predicateCount = 0;
  const transformed = ts.transform(file, [context => {
    const visit: ts.Visitor = node => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "INDEX_SYMBOLS") {
        mapCount++;
        if (!node.type || !ts.isTypeReferenceNode(node.type) || node.type.typeName.getText(file) !== "Record"
          || node.type.typeArguments?.length !== 2 || !ts.isTypeLiteralNode(node.type.typeArguments[1])
          || !node.initializer || !ts.isObjectLiteralExpression(node.initializer) || node.initializer.properties.length !== expected.size) fail("index-map-invalid");
        const fields = node.type.typeArguments[1];
        if (fields.members.length !== 2 || fields.members.map(row => row.name?.getText(file)).join(",") !== "symbol,name") fail("index-map-type-invalid");
        const seen = new Set<string>();
        const properties = node.initializer.properties.map(property => {
          if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) || !expected.has(property.name.text)
            || seen.has(property.name.text) || !ts.isObjectLiteralExpression(property.initializer)
            || property.initializer.properties.length !== 2
            || property.initializer.properties.map(row => row.name?.getText(file)).join(",") !== "symbol,name") fail("index-map-entry-invalid");
          seen.add(property.name.text);
          return ts.factory.updatePropertyAssignment(property, property.name, ts.factory.updateObjectLiteralExpression(property.initializer,
            [...property.initializer.properties, ts.factory.createPropertyAssignment("timeZone", ts.factory.createStringLiteral(property.name.text === "VIX" ? "America/Chicago" : "America/New_York"))]));
        });
        const timeZone = ts.factory.createPropertySignature(undefined, "timeZone", undefined,
          ts.factory.createUnionTypeNode(["America/New_York", "America/Chicago"].map(zone => ts.factory.createLiteralTypeNode(ts.factory.createStringLiteral(zone)))));
        const type = ts.factory.updateTypeReferenceNode(node.type, node.type.typeName,
          ts.factory.createNodeArray([node.type.typeArguments[0], ts.factory.updateTypeLiteralNode(fields, ts.factory.createNodeArray([...fields.members, timeZone]))]));
        return ts.factory.updateVariableDeclaration(node, node.name, node.exclamationToken, type,
          ts.factory.updateObjectLiteralExpression(node.initializer, ts.factory.createNodeArray(properties, node.initializer.properties.hasTrailingComma)));
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
        && node.left.getText(file) === "result.meta?.exchangeTimezoneName" && ts.isStringLiteral(node.right) && node.right.text === "America/New_York") {
        predicateCount++;
        return ts.factory.updateBinaryExpression(node, node.left, node.operatorToken,
          ts.factory.createParenthesizedExpression(ts.factory.createBinaryExpression(
            ts.factory.createPropertyAccessChain(ts.factory.createIdentifier("index"), ts.factory.createToken(ts.SyntaxKind.QuestionDotToken), "timeZone"),
            ts.factory.createToken(ts.SyntaxKind.QuestionQuestionToken), ts.factory.createStringLiteral("America/New_York"))));
      }
      return ts.visitEachChild(node, visit, context);
    };
    return node => ts.visitNode(node, visit) as ts.SourceFile;
  }]);
  try {
    if (mapCount !== 1 || predicateCount !== 1) fail("provider-boundary-invalid");
    return print(transformed.transformed[0]);
  } finally { transformed.dispose(); }
}

/** The only loader change tries the new authenticated lineage before the old
 * R15 bridge. Input normalization and all historic amendment guards stay equal. */
function correctedLoader(value: string): string {
  const file = source(value); let calls = 0;
  const transformed = ts.transform(file, [context => {
    const visit: ts.Visitor = node => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "continuation" && node.initializer
        && ts.isAwaitExpression(node.initializer) && ts.isCallExpression(node.initializer.expression)
        && node.initializer.expression.expression.getText(file) === "loadStorageIndexLoaderContinuation") {
        calls++;
        const original = node.initializer, call = node.initializer.expression;
        if (call.arguments.map(arg => arg.getText(file)).join(",") !== "ops,run,plan") fail("loader-arguments-changed");
        return ts.factory.updateVariableDeclaration(node, node.name, node.exclamationToken, node.type,
          ts.factory.createBinaryExpression(ts.factory.createAwaitExpression(ts.factory.createCallExpression(
            ts.factory.createIdentifier("loadStorageVixContinuation"), undefined, [...call.arguments])), ts.factory.createToken(ts.SyntaxKind.QuestionQuestionToken), original));
      }
      return ts.visitEachChild(node, visit, context);
    };
    return node => ts.visitNode(node, visit) as ts.SourceFile;
  }]);
  try {
    if (calls !== 1) fail("loader-boundary-invalid");
    return print(transformed.transformed[0]);
  } finally { transformed.dispose(); }
}
function withoutVixImport(value: string): string {
  const file = source(value), imports = file.statements.filter(node => ts.isImportDeclaration(node)
    && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "./market-storage-vix-continuation");
  if (imports.length !== 1 || printer.printNode(ts.EmitHint.Unspecified, imports[0], file)
    !== 'import { loadStorageVixContinuation } from "./market-storage-vix-continuation";') fail("loader-import-invalid");
  return print(ts.factory.updateSourceFile(file, file.statements.filter(node => !imports.includes(node))));
}

export function validateStorageVixCodeTrees(input: { fromRevision: string; codeRevision: string; before: Entry[]; after: Entry[];
  oldProvider: string; newProvider: string; oldLoader: string; newLoader: string }): StorageVixCodeContract {
  if (input.fromRevision !== STORAGE_VIX_PREVIOUS_REVISION || !/^[a-f0-9]{40}$/.test(input.codeRevision) || input.codeRevision === input.fromRevision) fail("revision-invalid");
  const maps = [input.before, input.after].map(rows => {
    if (!rows.length || rows.length > 20_000 || new Set(rows.map(row => row.path)).size !== rows.length
      || rows.some(row => !/^[a-f0-9]{40}$/.test(row.blob))) fail("tree-invalid");
    return new Map(rows.map(row => [row.path, row]));
  });
  const protectedFiles: Entry[] = [], changes = [];
  for (const path of [...new Set([...maps[0].keys(), ...maps[1].keys()])].sort()) {
    const old = maps[0].get(path), current = maps[1].get(path);
    if (path.startsWith("docs/") || path.startsWith("worker/test/")) continue;
    if (reviewed.has(path)) {
      if (!current || current.mode !== "100644") fail("reviewed-path-invalid");
      changes.push({ path, before: old?.blob ?? null, after: current.blob }); continue;
    }
    if (!old || !current || old.mode !== current.mode || old.blob !== current.blob) fail("protected-dependency-changed");
    protectedFiles.push(old);
  }
  if (!["worker/src/eod-runner.ts", "worker/src/market-history.ts", "worker/src/market-storage-acceptance.ts", "worker/src/market-storage-verification.ts",
    "worker/src/market-storage-history-index-continuation.ts", "worker/src/provider-usage.ts", "package-lock.json"].every(path => protectedFiles.some(row => row.path === path))) fail("manifest-incomplete");
  const expectedProvider = correctedProvider(input.oldProvider), expectedLoader = correctedLoader(input.oldLoader);
  if (expectedProvider !== print(source(input.newProvider))) fail("provider-delta-not-vix-only");
  if (expectedLoader !== withoutVixImport(input.newLoader)) fail("historic-loader-changed");
  const fields = { version: 1 as const, policy: "vix-chicago-identity-only-v1" as const, fromRevision: STORAGE_VIX_PREVIOUS_REVISION as typeof STORAGE_VIX_PREVIOUS_REVISION,
    codeRevision: input.codeRevision, protectedFileCount: protectedFiles.length, protectedManifestHash: digest(protectedFiles),
    providerContractHash: digest(expectedProvider), loaderContractHash: digest(expectedLoader), reviewedChangesHash: digest(changes),
    beforeTreeHash: digest(input.before), afterTreeHash: digest(input.after) };
  return { ...fields, evidenceHash: digest(fields) };
}
export function collectStorageVixCodeContract(input: { root: string; fromRevision: string; codeRevision: string }): StorageVixCodeContract {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: input.root, encoding: "utf8", windowsHide: true, timeout: 30_000,
    maxBuffer: 32_000_000, stdio: ["ignore", "pipe", "pipe"] });
  const tree = (revision: string) => git("ls-tree", "-r", "-z", revision).split("\0").filter(Boolean).map(row => {
    const match = /^(\d{6}) blob ([a-f0-9]{40})\t([^\0]+)$/.exec(row);
    if (!match) fail("tree-invalid"); return { path: match[3], mode: match[1], blob: match[2] };
  });
  return validateStorageVixCodeTrees({ ...input, before: tree(input.fromRevision), after: tree(input.codeRevision),
    oldProvider: git("show", `${input.fromRevision}:${providerPath}`), newProvider: git("show", `${input.codeRevision}:${providerPath}`),
    oldLoader: git("show", `${input.fromRevision}:${loaderPath}`), newLoader: git("show", `${input.codeRevision}:${loaderPath}`) });
}
