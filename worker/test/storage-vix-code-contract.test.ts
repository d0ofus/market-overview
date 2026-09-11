import { describe, expect, it } from "vitest";
import { validateStorageVixCodeTrees } from "../scripts/storage-vix-code-contract";
import { STORAGE_VIX_PREVIOUS_REVISION } from "../src/market-storage-vix-continuation";

const entries = ["VIX", "XOI", "XAU", "XNG", "OSX", "BKX", "INSR"];
const provider = (corrected: boolean) => `const INDEX_SYMBOLS: Record<string, { symbol: string; name: RegExp${corrected ? '; timeZone: "America/New_York" | "America/Chicago"' : ""} }> = {
${entries.map(ticker => `${ticker}: {symbol: "^${ticker}", name: /${ticker}/i${corrected ? `, timeZone: "${ticker === "VIX" ? "America/Chicago" : "America/New_York"}"` : ""}}`).join(",\n")}
};
const MARKET_DATE = "America/New_York";
function validate(result: {meta?: {exchangeTimezoneName?: string}}, index?: {timeZone: string}) {
return result.meta?.exchangeTimezoneName !== ${corrected ? '(index?.timeZone ?? "America/New_York")' : '"America/New_York"'};
}
function untouched() { return 100; }`;
const loader = (corrected: boolean) => `${corrected ? 'import { loadStorageVixContinuation } from "./market-storage-vix-continuation";' : ""}
import { loadStorageIndexLoaderContinuation } from "./market-storage-history-index-continuation";
export async function loadStorageHistoryIndexAmendment(ops: unknown, run: unknown, plan: unknown) {
  const text = "lookup";
  if (!text) {
    const continuation = ${corrected ? "await loadStorageVixContinuation(ops,run,plan) ?? " : ""}await loadStorageIndexLoaderContinuation(ops,run,plan);
    if (!continuation) return null;
    return continuation;
  }
  const recovery = text;
  if (!recovery) throw new Error("strict-existing-guard");
  return recovery;
}`;
const paths = ["worker/src/eod-runner.ts", "worker/src/market-history.ts", "worker/src/market-storage-acceptance.ts",
  "worker/src/market-storage-verification.ts", "worker/src/market-storage-history-index-continuation.ts", "worker/src/provider-usage.ts", "package-lock.json"];
const before = paths.map((path, index) => ({ path, mode: "100644", blob: String(index + 1).repeat(40) }));
const input = () => ({ fromRevision: STORAGE_VIX_PREVIOUS_REVISION, codeRevision: "d".repeat(40), before, after: [...before,
  { path: "worker/src/eod-price-provider.ts", mode: "100644", blob: "a".repeat(40) },
  { path: "worker/src/market-storage-history-index-recovery.ts", mode: "100644", blob: "b".repeat(40) }],
  oldProvider: provider(false), newProvider: provider(true), oldLoader: loader(false), newLoader: loader(true) });

describe("reviewed VIX correction code contract", () => {
  it("accepts only the mapped Chicago correction and authenticated lineage lookup", () => {
    const record = validateStorageVixCodeTrees(input());
    expect(record.policy).toBe("vix-chicago-identity-only-v1");
    expect(record.protectedFileCount).toBe(7);
    expect(record.providerContractHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it("preserves the actual provider map's trailing comma", () => {
    expect(validateStorageVixCodeTrees({ ...input(),
      oldProvider: provider(false).replace("name: /INSR/i}\n};", "name: /INSR/i},\n};"),
      newProvider: provider(true).replace('name: /INSR/i, timeZone: "America/New_York"}\n};', 'name: /INSR/i, timeZone: "America/New_York"},\n};') }).policy)
      .toBe("vix-chicago-identity-only-v1");
  });
  it("rejects another timezone, altered symbol identity and unrelated provider behavior", () => {
    for (const newProvider of [provider(true).replace('"America/Chicago"}', '"Europe/London"}'),
      provider(true).replace('"^VIX"', '"VXX"'), provider(true).replace("return 100", "return 1000"),
      provider(true).replace('const MARKET_DATE = "America/New_York"', 'const MARKET_DATE = "America/Chicago"')]) {
      expect(() => validateStorageVixCodeTrees({ ...input(), newProvider })).toThrow("provider-delta-not-vix-only");
    }
  });
  it("rejects weakened historical amendment validation or changed bridge arguments", () => {
    expect(() => validateStorageVixCodeTrees({ ...input(), newLoader: loader(true).replace('"strict-existing-guard"', '"weakened"') })).toThrow("historic-loader-changed");
    expect(() => validateStorageVixCodeTrees({ ...input(), newLoader: loader(true).replace("loadStorageVixContinuation(ops,run,plan)", "loadStorageVixContinuation(ops,run,{})") })).toThrow("historic-loader-changed");
  });
  it("rejects changed cache reuse, reader dependencies, or an unreviewed module", () => {
    for (const path of ["worker/src/eod-runner.ts", "worker/src/market-history.ts", "worker/src/provider-usage.ts"]) {
      expect(() => validateStorageVixCodeTrees({ ...input(), after: input().after.map(row => row.path === path ? { ...row, blob: "f".repeat(40) } : row) })).toThrow("protected-dependency-changed");
    }
    expect(() => validateStorageVixCodeTrees({ ...input(), after: [...input().after, { path: "worker/src/unreviewed.ts", mode: "100644", blob: "f".repeat(40) }] })).toThrow("protected-dependency-changed");
  });
  it("requires the actual R15 predecessor", () => {
    expect(() => validateStorageVixCodeTrees({ ...input(), fromRevision: "a".repeat(40) })).toThrow("revision-invalid");
  });
});
