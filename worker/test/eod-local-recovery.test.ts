import { describe, expect, it } from "vitest";
import { localRecoveryChildReason, localRecoveryFailure, runLocalStorageRecovery, type LocalRecoveryDependencies } from "../src/eod-local-recovery";
import type { StorageMigrationRun } from "../src/market-storage-control";

function fixture(status: StorageMigrationRun["status"], error = "storage-final-acceptance-required") {
  let run = { status, stage: "bootstrap", error_code: error, lease_until: null, next_attempt_at: null } as StorageMigrationRun;
  const calls: string[] = [];
  const deps: LocalRecoveryDependencies = {
    assertCheckout: async () => { calls.push("checkout"); }, hasCompleteSnapshot: async () => true,
    capture: async () => { calls.push("capture"); }, hasStarted: async () => true,
    analyzePreflight: async () => { calls.push("analyze"); }, start: async () => { calls.push("start"); },
    loadMigration: async () => run,
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
  it("rechecks completed activation without recopying data", async () => {
    const { deps, calls } = fixture("completed");
    await runLocalStorageRecovery(deps);
    expect(calls.filter((call) => call !== "checkout")).toEqual(["activate"]);
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
