import { describe, expect, it } from "vitest";
import { readEodRolloutMonitoring } from "../src/eod-rollout-monitor";
import { EOD_RETIREMENT_POLICY_VERSION } from "../src/eod-retirement-policy";
import { EOD_METRICS_VERSION } from "../src/eod-metrics";
import type { Env } from "../src/types";

const checkedAt = "2026-09-15T22:00:00.000Z";
function health() {
  return { checkedAt, codeRevision: "a".repeat(40), status: "passed", expectedSession: "2026-09-15",
    publicationCount: 6, missingScopes: [], completedRunId: "run-current", inputCorrectionsPending: false, reasons: [],
    usageDate: "2026-09-15", quotaSampledAt: checkedAt,
    quota: { eodRowsRead: 100, eodRowsWritten: 10, accountRowsRead: 1000, accountRowsWritten: 100, reservedReads: 0, reservedWrites: 0 } };
}
function envWithCachedHealth(currentHealth: unknown): Env {
  const value = { version: 3, policyVersion: EOD_RETIREMENT_POLICY_VERSION, methodologyVersion: EOD_METRICS_VERSION,
    checkedAt, mode: "active", requiredSessions: 0, consecutivePassedSessions: 0, eligibleForRetirement: true,
    latestEvaluatedSession: null, sessions: [], usageDays: [], newerSessions: [], usageFinalizationCutoff: null,
    currentHealth, reasons: [], operationalReasons: [] };
  const db = { prepare: () => ({ bind: () => ({ first: async () => ({ evidence_json: JSON.stringify(value) }) }) }) };
  return { OPS_DB: db as unknown as D1Database, EOD_RUNNER_MODE: "active", EOD_READ_ENABLED: "true" } as Env;
}

describe("cached current health without observation requirements", () => {
  it("retains a typed expired record while removing its current-health claim", async () => {
    const env = envWithCachedHealth(health());
    expect(await readEodRolloutMonitoring(env, new Date(checkedAt))).toMatchObject({ eligibleForRetirement: true,
      currentHealth: { status: "passed" } });
    expect(await readEodRolloutMonitoring(env, new Date("2026-09-15T22:06:00Z"))).toMatchObject({ stale: false,
      eligibleForRetirement: false, currentHealth: { status: "pending", publicationCount: 6,
        reasons: ["current-health-evidence-expired"] }, reasons: ["current-health-evidence-expired"] });
  });
  it("marks malformed cached health unavailable instead of spreading invalid reasons", async () => {
    expect(await readEodRolloutMonitoring(envWithCachedHealth({ ...health(), reasons: null }), new Date(checkedAt)))
      .toMatchObject({ eligibleForRetirement: false, currentHealth: null, reasons: ["current-health-evidence-unavailable"] });
  });
});
