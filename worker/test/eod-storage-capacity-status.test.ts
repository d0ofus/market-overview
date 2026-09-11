import { describe, expect, it } from "vitest";
import { loadStorageHistoryCapacityStatus } from "../src/eod-storage-history-capacity";
import type { Env } from "../src/types";

const revision = "a".repeat(40), now = new Date("2026-09-11T12:00:00Z");
const capacity = { status: "ready", checkedAt: "2026-09-11T00:35:00Z", error: null, hotSessions: 90,
  feeds: ["sip", "yahoo-eod"], forecastSessions: 20, forecastAnchorSession: "2026-09-08", forecastLastSession: "2026-10-06",
  horizonExpiresAt: "2026-10-07T00:00:00Z", forecastRunId: "eod:active:2026-09-08:daily", analysisHash: "b".repeat(64),
  proofHash: "c".repeat(64), marketPhysicalBytes: 200_000_000, archivePhysicalBytes: 100_000_000 };
const renewal = { version: 1, codeRevision: revision, attemptId: "10000000-0000-4000-8000-000000000001", status: "running", stage: "capture",
  updatedAt: "2026-09-11T11:50:00Z", leaseUntil: "2026-09-11T14:50:00Z", nextAttemptAt: null, error: null,
  previousProofHash: capacity.proofHash, populationHash: "d".repeat(64), progress: { localPath: "private-local-path", copiedRows: 20 } };
function fixture(values: { capacity?: unknown; renewal?: unknown } = {}) {
  const rows = new Map([
    [`history-storage-status:${revision}`, JSON.stringify(values.capacity ?? capacity)],
    [`history-capacity-renewal:${revision}`, JSON.stringify(values.renewal ?? renewal)],
  ]);
  const ids: string[] = [];
  const ops = { prepare(sql: string) {
    if (sql !== "SELECT evidence_json FROM eod_rollout_evidence WHERE id=?") throw new Error("Status must use bounded cached metadata only.");
    return { bind(id: string) { ids.push(id); return { first: async () => rows.get(id) ?? null }; } };
  } } as unknown as D1Database;
  return { env: { DB: ops, OPS_DB: ops, EOD_CODE_REVISION: revision } as Env, ids, rows };
}

describe("cached capacity renewal visibility", () => {
  it("exposes dated progress with two indexed reads and omits local paths, manifests and attempt identifiers", async () => {
    const f = fixture(), result = await loadStorageHistoryCapacityStatus(f.env, now);
    expect(result).toMatchObject({ status: "ready", renewal: { status: "running", stage: "capture", updatedAt: renewal.updatedAt } });
    expect(f.ids).toEqual([`history-storage-status:${revision}`, `history-capacity-renewal:${revision}`]);
    expect(JSON.stringify(result)).not.toContain("private-");
    expect(result?.renewal).not.toHaveProperty("progress");
    expect(result?.renewal).not.toHaveProperty("attemptId");
  });
  it("shows an interrupted lease as recoverable without advancing the storage forecast", async () => {
    const f = fixture({ renewal: { ...renewal, leaseUntil: "2026-09-11T11:59:00Z" } });
    expect(await loadStorageHistoryCapacityStatus(f.env, now)).toMatchObject({ horizonExpiresAt: capacity.horizonExpiresAt,
      renewal: { status: "failed", error: "attempt-interrupted", nextAttemptAt: now.toISOString() } });
  });
  it("keeps expired capacity failed even if the prior renewal attempt completed", async () => {
    const f = fixture({ capacity: { ...capacity, horizonExpiresAt: "2026-09-11T00:00:00Z" },
      renewal: { ...renewal, status: "completed", leaseUntil: null } });
    expect(await loadStorageHistoryCapacityStatus(f.env, now)).toMatchObject({ status: "expired", error: "forecast-horizon-expired",
      renewal: { status: "completed" } });
  });
  it("reports unreadable renewal metadata without hiding the last measured capacity or exposing its body", async () => {
    const f = fixture(); f.rows.set(`history-capacity-renewal:${revision}`, "invalid private-body");
    const result = await loadStorageHistoryCapacityStatus(f.env, now);
    expect(result).toMatchObject({ status: "ready", renewal: { status: "unavailable", updatedAt: null, nextAttemptAt: null,
      error: "capacity-renewal-status-unavailable" } });
    expect(JSON.stringify(result)).not.toContain("private-body");
  });
});
