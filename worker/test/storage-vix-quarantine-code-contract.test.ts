import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateStorageVixQuarantineCodeTrees } from "../scripts/storage-vix-quarantine-code-contract";
import { STORAGE_VIX_QUARANTINE_PREVIOUS_REVISION } from "../src/market-storage-vix-continuation";

// Captured R16 source and the exact reviewed combined correction. This fixture
// does not read the working tree or rely on GitHub checkout history at test time.
const source = JSON.parse(readFileSync(new URL("./fixtures/vix-rsho-code-contract.json", import.meta.url), "utf8")) as {
  oldProvider: string; newProvider: string; oldRunner: string; newRunner: string;
  oldRepair: string; newRepair: string; newAlias: string;
};
const before = ["worker/src/market-history.ts", "worker/src/market-storage-acceptance.ts", "worker/src/market-storage-verification.ts",
  "worker/src/market-storage-history-index-recovery.ts", "worker/src/market-storage-history-index-continuation.ts", "worker/src/provider-usage.ts",
  "worker/src/eod-metrics.ts", "worker/src/eod-bar-store.ts", "package-lock.json"].map((path, index) => ({ path, mode: "100644", blob: String(index + 1).repeat(40) }));
const input = () => ({ fromRevision: STORAGE_VIX_QUARANTINE_PREVIOUS_REVISION, codeRevision: "d".repeat(40), before, after: before, ...source });
function change(value: string, old: string, next: string): string {
  expect(value).toContain(old);
  return value.replace(old, next);
}

describe("combined VIX sessions and dated RSHO alias code contract", () => {
  it("accepts only the actual reviewed provider, disclosure and writer changes", () => {
    expect(validateStorageVixQuarantineCodeTrees(input()).policy).toBe("vix-sessions-rsho-dated-alias-only-v2");
    const current = input();
    expect(validateStorageVixQuarantineCodeTrees({ ...current, newProvider: current.newProvider.replace(/\n/g, "\r\n"),
      newRunner: current.newRunner.replace(/\n/g, "\r\n"), newRepair: current.newRepair.replace(/\n/g, "\r\n"),
      newAlias: current.newAlias.replace(/\n/g, "\r\n") }).version).toBe(2);
  });
  it("rejects broadened quarantine and invalid-date acceptance", () => {
    for (const [old, next] of [['ticker !== "VIX"', 'ticker !== "SPY"'], ["dates.slice(0, 12)", "dates.slice(0, 200)"],
      ["!validEodBar(bar, calendarDates.at(-1)!)", "false"]]) {
      expect(() => validateStorageVixQuarantineCodeTrees({ ...input(), newProvider: change(source.newProvider, old, next) })).toThrow("quarantine-helper-changed");
    }
  });
  it("rejects other aliases, effective dates and relaxed provider identity", () => {
    for (const [old, next] of [['currentSymbol: "WELD"', 'currentSymbol: "SPY"'], ['effectiveDate: "2026-06-22"', 'effectiveDate: "2026-01-01"'],
      ['asofDate: "2026-06-18"', 'asofDate: "2026-06-22"']]) {
      expect(() => validateStorageVixQuarantineCodeTrees({ ...input(), newAlias: change(source.newAlias, old, next) })).toThrow("dated-alias-changed");
    }
    expect(() => validateStorageVixQuarantineCodeTrees({ ...input(), newProvider: change(source.newProvider,
      'result.meta.instrumentType !== "ETF"', 'false') })).toThrow("existing-provider-changed");
  });
  it("preserves provider URLs, template strings and the observed basis check", () => {
    expect(() => validateStorageVixQuarantineCodeTrees({ ...input(), newProvider: change(source.newProvider,
      "https://data.alpaca.markets/v2/stocks/bars?", "https://unreviewed.test/bars?") })).toThrow("existing-provider-changed");
    expect(() => validateStorageVixQuarantineCodeTrees({ ...input(), newRunner: change(source.newRunner,
      "this fund trades as", "this other security trades as") })).toThrow("runner-delta-not-quarantine-only");
    expect(() => validateStorageVixQuarantineCodeTrees({ ...input(), newProvider: change(source.newProvider,
      "comparisons.length < 2", "comparisons.length < 0") })).toThrow("existing-provider-changed");
  });
  it("rejects weakening cache reuse, repair completeness or archive writes", () => {
    expect(() => validateStorageVixQuarantineCodeTrees({ ...input(), newRunner: change(source.newRunner,
      "feature.price!==null", "true") })).toThrow("runner-delta-not-quarantine-only");
    expect(() => validateStorageVixQuarantineCodeTrees({ ...input(), newRepair: change(source.newRepair,
      "!dates.has(target)", "false") })).toThrow("repair-delta-not-quarantine-only");
    expect(() => validateStorageVixQuarantineCodeTrees({ ...input(), newRunner: change(source.newRunner,
      "archiveMarketHistoryBars(env,fallback)", "archiveMarketHistoryBars(env,fetchedFallback)") })).toThrow("runner-delta-not-quarantine-only");
  });
  it("requires R16 and unchanged consumers and accounting", () => {
    expect(() => validateStorageVixQuarantineCodeTrees({ ...input(), fromRevision: "a".repeat(40) })).toThrow("revision-invalid");
    expect(() => validateStorageVixQuarantineCodeTrees({ ...input(), after: before.map(row => row.path === "worker/src/eod-metrics.ts"
      ? { ...row, blob: "f".repeat(40) } : row) })).toThrow("protected-dependency-changed");
  });
});
