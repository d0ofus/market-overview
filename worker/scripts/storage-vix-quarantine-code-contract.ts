import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import ts from "typescript";
import { STORAGE_VIX_QUARANTINE_PREVIOUS_REVISION, type StorageVixQuarantineCodeContract } from "../src/market-storage-vix-continuation";

type Entry = { path: string; mode: string; blob: string };
type Token = [number, string];
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const providerPath = "worker/src/eod-price-provider.ts", runnerPath = "worker/src/eod-runner.ts", repairPath = "worker/src/eod-price-repair.ts", aliasPath = "worker/src/eod-ticker-aliases.ts";
const reviewed = new Set([providerPath, runnerPath, repairPath, aliasPath, "worker/src/market-storage-vix-continuation.ts",
  "worker/scripts/storage-vix-quarantine-code-contract.ts", "worker/scripts/continue-storage-vix-quarantine.ts", "worker/tsconfig.runner.json"]);
// Exact reviewed helper AST tokens: VIX only, validated Yahoo/split provenance,
// unchanged authoritative session dates, valid OHLC, bounded discarded dates.
const ALIAS_HASH = "9c3c912fa61aceda508d90e4a6063ba5833da4a404e7feca77ad4e698845370c";
const HELPER_HASH = "bb8f5e8b5d8cfc6935e002d499017126b31d065afc60d7a47dae20d391de9ce5";
function fail(reason: string): never { throw new Error(`storage-vix-quarantine-code-${reason}`); }
function source(value: string): ts.SourceFile {
  const file = ts.createSourceFile("contract.ts", value, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if ((file as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length) fail("syntax-invalid");
  return file;
}
function fragmentTokens(value: string): Token[] {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, value), result: Token[] = [];
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) result.push([0, scanner.getTokenText()]);
  return result;
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
function replaceExact(input: Token[], old: Token[], next: Token[]): Token[] {
  const found: number[] = [];
  for (let index = 0; index <= input.length - old.length; index++) {
    if (old.every((token, offset) => token[0] === input[index + offset][0] && token[1] === input[index + offset][1])) found.push(index);
  }
  if (found.length !== 1) fail("writer-boundary-invalid");
  return [...input.slice(0, found[0]), ...next, ...input.slice(found[0] + old.length)];
}
function replaceOne(input: Token[], before: string, after: string): Token[] {
  return replaceExact(input, fragmentTokens(before), fragmentTokens(after));
}
const providerChanges: ReadonlyArray<readonly [string, string]> = [
  ['import { getEtfLifecycle } from "./etf-holdings-quality";',
    'import { getEtfLifecycle } from "./etf-holdings-quality"; import { reviewedEodTickerAlias } from "./eod-ticker-aliases";'],
  ['export function yahooEodSymbol(ticker: string): string { const normalized = ticker.trim().toUpperCase();',
    'export function yahooEodSymbol(ticker: string, targetSession?: string): string { const normalized = ticker.trim().toUpperCase(); const alias = targetSession ? reviewedEodTickerAlias(normalized, targetSession) : null; if (alias) return alias.currentSymbol;'],
  ['private async alpacaPages(tickers: string[], start: string, target: string, adjustment: "split" | "raw"): Promise<EodPriceBar[]> {',
    'private async alpacaPages(tickers: string[], start: string, target: string, adjustment: "split" | "raw", asof = target): Promise<EodPriceBar[]> {'],
  ['end, feed: "sip", adjustment, asof: target, limit: "10000", sort: "asc"',
    'end, feed: "sip", adjustment, asof, limit: "10000", sort: "asc"'],
  ['const fetchBatch = async (symbols: string[]): Promise<EodPriceBar[]> => {',
    'const fetchBatch = async (symbols: string[], asof = target): Promise<EodPriceBar[]> => {'],
  ['return await this.alpacaPages(symbols, start, target, adjustment);',
    'return await this.alpacaPages(symbols, start, target, adjustment, asof);'],
  ['return [...await fetchBatch(symbols.slice(0, split)), ...await fetchBatch(symbols.slice(split))];',
    'return [...await fetchBatch(symbols.slice(0, split), asof), ...await fetchBatch(symbols.slice(split), asof)];'],
  ['return fetchBatch(supported);',
    'const ordinary = supported.filter((ticker) => !reviewedEodTickerAlias(ticker, target)); const out = await fetchBatch(ordinary); for (const ticker of supported.filter((symbol) => reviewedEodTickerAlias(symbol, target))) { out.push(...await fetchBatch([ticker], reviewedEodTickerAlias(ticker, target)!.asofDate)); } return out;'],
  ['const symbol = yahooEodSymbol(ticker);',
    'const alias = reviewedEodTickerAlias(ticker, target); const symbol = yahooEodSymbol(ticker, target);'],

];
const runnerChanges: ReadonlyArray<readonly [string, string]> = [
  ['import { EodPriceProvider, yahooWindowMatchesAlpaca, type EodPriceBar } from "./eod-price-provider";',
    'import { EodPriceProvider, selectYahooEodSessions, yahooWindowMatchesAlpaca, type EodPriceBar } from "./eod-price-provider"; import { reviewedEodTickerAlias } from "./eod-ticker-aliases";'],
  ["for (const row of yahooPending.results) {", "const yahooRepairDiagnostics=new Map<string,string>(); for (const row of yahooPending.results) {"],
  ["const repaired=await repairEodYahoo(env,provider,row.ticker,run.session_date,row.startDate,history.filter((bar) => bar.ticker===row.ticker)); ownRevisionChanges.push(...repaired.revisions);",
    "const repaired=await repairEodYahoo(env,provider,row.ticker,run.session_date,row.startDate,history.filter((bar) => bar.ticker===row.ticker)); ownRevisionChanges.push(...repaired.revisions); if (repaired.diagnostic) yahooRepairDiagnostics.set(row.ticker,repaired.diagnostic);"],
  ["for (const ticker of tickers) { checkContinuation(); const lifecycle = getEtfLifecycle(ticker);",
    "for (const ticker of tickers) { checkContinuation(); const repairDiagnostic=yahooRepairDiagnostics.get(ticker); if (repairDiagnostic) errors[ticker]=repairDiagnostic; const lifecycle = getEtfLifecycle(ticker);"],
  ['const fallback=await provider.yahoo(ticker,start,run.session_date,own); checkContinuation(); if (fallback.some((bar) => !inputs.calendarDates.includes(bar.date))) throw new Error("yahoo-unexpected-exchange-session");',
    "const fetchedFallback=await provider.yahoo(ticker,start,run.session_date,own); checkContinuation(); const {bars:fallback,diagnostic}=selectYahooEodSessions(ticker,fetchedFallback,inputs.calendarDates); if (diagnostic) errors[ticker]=diagnostic;"],
];
// Parse complete statements to preserve template-literal text in the reviewed
// disclosure. Object wrappers are stripped only after tokenization.
function correctedOverview(input: Token[]): Token[] {
  const withReason = replaceExact(input, tokens("const reason = hasPrice ? `Verified ${session} EOD close from ${source}; each populated metric requires its exact session window.`\n            : closed ? `No current price: fund liquidated ${lifecycle.liquidationDate}; last trading session ${lifecycle.lastTradingDate}. Source result: ${lifecycle.sourceUrl}`\n            : `No verified EOD price for ${session}; no earlier quote is substituted.${failure ? ` Source result: ${failure}.` : \"\"}`;"), tokens("const alias = reviewedEodTickerAlias(item.ticker, session);\n          const identityDetail = alias ? ` ${item.ticker} is the retained historical alias; this fund trades as ${alias.currentSymbol} from ${alias.effectiveDate}. Issuer: ${alias.sourceUrl}` : \"\";\n          const reason = (hasPrice ? `Verified ${session} EOD close from ${source}; each populated metric requires its exact session window.`\n            : closed ? `No current price: fund liquidated ${lifecycle.liquidationDate}; last trading session ${lifecycle.lastTradingDate}. Source result: ${lifecycle.sourceUrl}`\n            : `No verified EOD price for ${session}; no earlier quote is substituted.${failure ? ` Source result: ${failure}.` : \"\"}`) + identityDetail;"));
  return replaceExact(withReason, tokens("const row = { displayName: item.displayName };").slice(4, -2), tokens("const row = { displayName: alias ? `${alias.currentSymbol} (formerly ${item.ticker}) - ${alias.name}` : item.displayName };").slice(4, -2));
}
const repairChanges: ReadonlyArray<readonly [string, string]> = [
  ['import { EodPriceProvider, type EodPriceBar } from "./eod-price-provider";',
    'import { EodPriceProvider, selectYahooEodSessions, type EodPriceBar } from "./eod-price-provider";'],
  ["const bars=await provider.yahoo(ticker,start,target,alpaca);", "const fetchedBars=await provider.yahoo(ticker,start,target,alpaca);"],
  ['const sessions=new Set(calendar.results.map((row) => row.date)); if (bars.some((bar) => !sessions.has(bar.date))) throw new Error("yahoo-unexpected-exchange-session");',
    "const {bars,diagnostic}=selectYahooEodSessions(ticker,fetchedBars,calendar.results.map((row) => row.date).sort());"],
  ["return {bars,revisions:archived.revisionChanges};", "return {bars,revisions:archived.revisionChanges,diagnostic};"],
];
function corrected(value: string, changes: ReadonlyArray<readonly [string, string]>): Token[] {
  source(value);
  return changes.reduce((result, [before, after]) => replaceOne(result, before, after), tokens(value));
}

function correctedProvider(value: string): Token[] {
  const base = corrected(value, providerChanges);
  const expression = (text: string) => tokens(`const condition = ${text};`).slice(3, -1);
  const ordinary = '(!index && (result.meta.currency!=="USD" || !["EQUITY","ETF"].includes(result.meta.instrumentType ?? "")))';
  const alias = '(alias && (result.meta.instrumentType !== "ETF" || ![result.meta.shortName, result.meta.longName].some((name) => typeof name === "string" && name.toLowerCase().replace(/[^a-z0-9]/g, "") === alias.name.toLowerCase().replace(/[^a-z0-9]/g, ""))))';
  return replaceExact(base, [...fragmentTokens("||"), ...expression(ordinary)],
    [...fragmentTokens("||"), ...expression(ordinary), ...fragmentTokens("||"), ...expression(alias)]);
}

/** The reviewed VIX session selection, dated RSHO alias and disclosure are
 * exact token substitutions after syntax parsing. Cache, calendar, price-basis,
 * archive/fence/revision writes and every other provider check remain unchanged. */
export function validateStorageVixQuarantineCodeTrees(input: { fromRevision: string; codeRevision: string; before: Entry[]; after: Entry[];
  oldProvider: string; newProvider: string; newAlias: string; oldRunner: string; newRunner: string; oldRepair: string; newRepair: string }): StorageVixQuarantineCodeContract {
  if (input.fromRevision !== STORAGE_VIX_QUARANTINE_PREVIOUS_REVISION || !/^[a-f0-9]{40}$/.test(input.codeRevision)
    || input.codeRevision === input.fromRevision) fail("revision-invalid");
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
  if (!["worker/src/market-history.ts", "worker/src/market-storage-acceptance.ts", "worker/src/market-storage-verification.ts",
    "worker/src/market-storage-history-index-recovery.ts", "worker/src/market-storage-history-index-continuation.ts", "worker/src/provider-usage.ts",
    "worker/src/eod-metrics.ts", "worker/src/eod-bar-store.ts", "package-lock.json"].every(path => protectedFiles.some(row => row.path === path))) fail("manifest-incomplete");
  source(input.oldProvider);
  const provider = source(input.newProvider), helpers = provider.statements.filter((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === "selectYahooEodSessions");
  if (helpers.length !== 1 || digest(tokens(helpers[0].getText(provider))) !== HELPER_HASH) fail("quarantine-helper-changed");
  const withoutHelper = input.newProvider.slice(0, helpers[0].getFullStart()) + input.newProvider.slice(helpers[0].end);
  if (digest(correctedProvider(input.oldProvider)) !== digest(tokens(withoutHelper))) fail("existing-provider-changed");
  if (digest(tokens(input.newAlias)) !== ALIAS_HASH) fail("dated-alias-changed");
  const expectedRunner = correctedOverview(corrected(input.oldRunner, runnerChanges)), expectedRepair = corrected(input.oldRepair, repairChanges);
  source(input.newRunner); source(input.newRepair);
  if (digest(expectedRunner) !== digest(tokens(input.newRunner))) fail("runner-delta-not-quarantine-only");
  if (digest(expectedRepair) !== digest(tokens(input.newRepair))) fail("repair-delta-not-quarantine-only");
  const fields = { version: 2 as const, policy: "vix-sessions-rsho-dated-alias-only-v2" as const,
    fromRevision: STORAGE_VIX_QUARANTINE_PREVIOUS_REVISION as typeof STORAGE_VIX_QUARANTINE_PREVIOUS_REVISION,
    codeRevision: input.codeRevision, protectedFileCount: protectedFiles.length, protectedManifestHash: digest(protectedFiles),
    providerContractHash: digest([tokens(input.oldProvider), HELPER_HASH, ALIAS_HASH, correctedProvider(input.oldProvider)]), writerContractHash: digest([expectedRunner, expectedRepair]),
    reviewedChangesHash: digest(changes), beforeTreeHash: digest(input.before), afterTreeHash: digest(input.after) };
  return { ...fields, evidenceHash: digest(fields) };
}
export function collectStorageVixQuarantineCodeContract(input: { root: string; fromRevision: string; codeRevision: string }): StorageVixQuarantineCodeContract {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: input.root, encoding: "utf8", windowsHide: true, timeout: 30_000,
    maxBuffer: 32_000_000, stdio: ["ignore", "pipe", "pipe"] });
  const tree = (revision: string) => git("ls-tree", "-r", "-z", revision).split("\0").filter(Boolean).map(row => {
    const match = /^(\d{6}) blob ([a-f0-9]{40})\t([^\0]+)$/.exec(row);
    if (!match) fail("tree-invalid"); return { path: match[3], mode: match[1], blob: match[2] };
  });
  return validateStorageVixQuarantineCodeTrees({ ...input, before: tree(input.fromRevision), after: tree(input.codeRevision),
    oldProvider: git("show", `${input.fromRevision}:${providerPath}`), newProvider: git("show", `${input.codeRevision}:${providerPath}`),
    oldRunner: git("show", `${input.fromRevision}:${runnerPath}`), newRunner: git("show", `${input.codeRevision}:${runnerPath}`),
    newAlias: git("show", `${input.codeRevision}:${aliasPath}`),
    oldRepair: git("show", `${input.fromRevision}:${repairPath}`), newRepair: git("show", `${input.codeRevision}:${repairPath}`) });
}
