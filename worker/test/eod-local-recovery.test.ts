import { describe, expect, it } from "vitest";
import { localRecoveryChildReason, localRecoveryFailure, localRecoveryRequiresBootstrapRefresh, parseLocalPopulationSizing, runLocalStorageRecovery, type LocalRecoveryDependencies } from "../src/eod-local-recovery";
import type { StorageMigrationRun } from "../src/market-storage-control";
import { storageHash } from "../src/market-storage-pages";

function fixture(status: StorageMigrationRun["status"], error = "storage-final-acceptance-required") {
  let run = { status, stage: "bootstrap", error_code: error, lease_until: null, next_attempt_at: null } as StorageMigrationRun;
  const calls: string[] = [];
  const deps: LocalRecoveryDependencies = {
    assertCheckout: async () => { calls.push("checkout"); }, hasCompleteSnapshot: async () => true,
    capture: async () => { calls.push("capture"); }, hasStarted: async () => true,
    analyzePreflight: async () => { calls.push("analyze"); }, start: async () => { calls.push("start"); },
    loadMigration: async () => run,
    preparePopulationSizing: async () => { calls.push("population-size"); run = { ...run, status: "retrying", stage: "consumers", error_code: null }; },
    prepareAcceptance: async () => { calls.push("measure"); },
    accept: async () => { calls.push("accept"); run = { ...run, status: "awaiting-cutover" }; },
    activate: async () => { calls.push("activate"); run = { ...run, status: "completed" }; },
  };
  return { deps, calls };
}
describe("restartable local recovery ordering", () => {
  it("preserves the measured capacity blocker without forwarding arbitrary child output", () => {
    const reason = localRecoveryChildReason('untrusted provider body\n{"status":"paused","reason":"storage-preflight-insufficient-headroom"}');
    expect(reason).toBe("storage-preflight-insufficient-headroom");
    expect(localRecoveryFailure(reason!, "start")).toMatchObject({ status: "paused", nextAttemptAt: null, reason });
    expect(localRecoveryChildReason('{"reason":"secret-value"}')).toBeNull();
  });
  it("never activates before fresh durable acceptance", async () => {
    const { deps, calls } = fixture("awaiting-evidence");
    expect((await runLocalStorageRecovery(deps)).status).toBe("completed");
    expect(calls.filter((call) => call !== "checkout")).toEqual(["measure", "accept", "activate"]);
  });
  it("does not treat an accepted CLI response as persisted acceptance", async () => {
    const { deps, calls } = fixture("awaiting-evidence"); deps.accept = async () => undefined;
    await expect(runLocalStorageRecovery(deps)).rejects.toThrow("acceptance-not-persisted");
    expect(calls).not.toContain("activate");
  });
  it("leaves GitHub stages and verification failures to their own recovery", async () => {
    for (const status of ["running", "retrying", "awaiting-evidence"] as const) {
      const { deps, calls } = fixture(status, "storage-checksum-mismatch");
      expect((await runLocalStorageRecovery(deps)).status).toBe(status === "awaiting-evidence" ? "paused" : "waiting");
      expect(calls).not.toContain("measure"); expect(calls).not.toContain("activate");
    }
  });
  it("keeps post-bootstrap population drift visibly paused with no repeated reconstruction", async () => {
    const reason = "storage-population-live-recapture-required";
    const { deps, calls } = fixture("awaiting-evidence", reason);
    expect(await runLocalStorageRecovery(deps)).toEqual({ status: "paused", stage: "bootstrap", nextAttemptAt: null, reason });
    expect(calls.filter((call) => call !== "checkout")).toEqual([]);
    expect(localRecoveryRequiresBootstrapRefresh(JSON.stringify({ reason }))).toBe(false);
  });
  it("reconstructs only identified stale sessions or price revisions from sanitized child failures", () => {
    for (const reason of ["storage-acceptance-completed-latest-run-required", "storage-acceptance-publication-inputs-changed",
      "storage-validation-bootstrap-latest-session-required"]) {
      expect(localRecoveryRequiresBootstrapRefresh(reason + "\n")).toBe(true);
      expect(localRecoveryRequiresBootstrapRefresh(JSON.stringify({ id: "market-storage:test", status: "awaiting-evidence", reason }))).toBe(true);
    }
    for (const reason of ["storage-bootstrap-input-plan-changed", "storage-validation-bootstrap-plan-mismatch",
      "private provider text storage-acceptance-publication-inputs-changed"]) {
      expect(localRecoveryRequiresBootstrapRefresh(reason)).toBe(false);
      expect(localRecoveryRequiresBootstrapRefresh(JSON.stringify({ reason }))).toBe(false);
    }
  });
  it("rechecks completed activation without recopying data", async () => {
    const { deps, calls } = fixture("completed");
    await runLocalStorageRecovery(deps);
    expect(calls.filter((call) => call !== "checkout")).toEqual(["activate"]);
  });
  it("measures a pending current-population plan and resumes without claiming acceptance or activation", async () => {
    const { deps, calls } = fixture("awaiting-evidence", "storage-population-sizing-required");
    expect(await runLocalStorageRecovery(deps)).toMatchObject({ status: "waiting", stage: "consumers", reason: "current-population-sizing-accepted" });
    expect(calls.filter((call) => call !== "checkout")).toEqual(["population-size"]);
  });
  it("requires durable sizing approval and retries quota without advancing any other stage", async () => {
    const { deps, calls } = fixture("awaiting-evidence", "storage-population-sizing-required");
    deps.preparePopulationSizing = async () => undefined;
    await expect(runLocalStorageRecovery(deps)).rejects.toThrow("population-sizing-not-persisted");
    deps.preparePopulationSizing = async () => { throw new Error("eod-budget-exhausted"); };
    await expect(runLocalStorageRecovery(deps)).rejects.toThrow("eod-budget-exhausted");
    expect(calls).not.toContain("activate"); expect(calls).not.toContain("measure");
  });
  it("keeps the original snapshot date while accepting the exact new population manifest", async () => {
    const expected = { migrationId: "market-storage:test", codeRevision: "a".repeat(40), originalSessionDate: "2026-09-08" };
    const manifest = { version: 1, migrationId: expected.migrationId, codeRevision: expected.codeRevision, planHash: "b".repeat(64),
      sessionDate: "2026-09-08", bootstrapSessionDate: "2026-09-11", tickers: ["AAA", "NEW"], tickerHash: await storageHash(["AAA", "NEW"]) };
    expect(await parseLocalPopulationSizing(manifest, expected)).toEqual(manifest);
    await expect(parseLocalPopulationSizing({ ...manifest, sessionDate: "2026-09-11" }, expected)).rejects.toThrow("identity-conflict");
    await expect(parseLocalPopulationSizing({ ...manifest, tickers: ["AAA"] }, expected)).rejects.toThrow("identity-conflict");
    await expect(parseLocalPopulationSizing({ ...manifest, codeRevision: "c".repeat(40) }, expected)).rejects.toThrow("identity-conflict");
    await expect(parseLocalPopulationSizing({ ...manifest, tickers: ["NEW", "AAA"] }, expected)).rejects.toThrow("identity-conflict");
  });
  it("requires a complete capture before provisioning", async () => {
    const { deps, calls } = fixture("queued"); deps.hasStarted = async () => false;
    deps.hasCompleteSnapshot = async () => false;
    await expect(runLocalStorageRecovery(deps)).rejects.toThrow("snapshot-incomplete");
    expect(calls).not.toContain("start");
  });
  it("waits until the UTC reset after quota exhaustion and keeps validation failures paused", () => {
    const now = new Date("2026-09-09T23:00:00Z");
    expect(localRecoveryFailure("eod-budget-exhausted", "capture", now).nextAttemptAt).toBe("2026-09-10T00:05:00.000Z");
    expect(localRecoveryFailure("storage-input-mismatch", "accept", now).status).toBe("paused");
    expect(localRecoveryFailure("private secret server response", "accept", now).reason).toBe("storage-local-review-required");
  });
});
