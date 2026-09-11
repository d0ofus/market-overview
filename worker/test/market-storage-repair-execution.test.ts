import { describe, expect, it } from "vitest";
import { storageRepairExecutionBoundary } from "../src/market-storage-repair-execution";

const now = new Date("2026-09-11T23:00:00.000Z");
const migration = { status: "awaiting-evidence" as const, stage: "bootstrap", error_code: "storage-copy-verification-failed",
  next_attempt_at: null, updated_at: "2026-09-11T22:39:48.000Z" };
const eod = { id: "eod:active:2026-09-10:daily", input_json: "{}", progress_json: "{}", status: "retrying", stage: "prices",
  mode: "active", purpose: "daily", error_code: "runner-error", error_message: "adjustment-repair-incomplete",
  completed_at: null, completed_input_clock: null, next_attempt_at: "2026-09-11T22:54:48.000Z", updated_at: "2026-09-11T22:39:48.000Z" };
const progress = { total: 253, chunk: 245, symbols: 6_125 };

describe("exact incomplete-repair execution boundary", () => {
  it("retains the actual EOD retry due time and does not claim a planned slice", () => {
    expect(storageRepairExecutionBoundary(migration, eod, progress, 6_319, now)).toEqual({ kind: "prices",
      resume: { status: "queued", errorCode: null, nextAttemptAt: eod.next_attempt_at } });
  });
  it.each(["storage-run-time-slice-complete", "adjustment-repair-already-owned", "alpaca-http-429", "d1-network-error"])("rejects %s", error_message => {
    expect(() => storageRepairExecutionBoundary(migration, { ...eod, error_message }, progress, 6_319, now)).toThrow("incomplete-repair-boundary-required");
  });
  it.each(["queued", "running", "retrying", "completed"])("rejects migration status %s", status => {
    expect(() => storageRepairExecutionBoundary({ ...migration, status: status as typeof migration.status }, eod, progress, 6_319, now)).toThrow();
  });
  it("rejects unrelated pause, stage, non-null retry, future cooldown and completed inputs", () => {
    expect(() => storageRepairExecutionBoundary({ ...migration, error_code: "storage-final-acceptance-required" }, eod, progress, 6_319, now)).toThrow();
    expect(() => storageRepairExecutionBoundary({ ...migration, stage: "verification" }, eod, progress, 6_319, now)).toThrow();
    expect(() => storageRepairExecutionBoundary({ ...migration, next_attempt_at: now.toISOString() }, eod, progress, 6_319, now)).toThrow();
    expect(() => storageRepairExecutionBoundary(migration, { ...eod, next_attempt_at: "2026-09-11T23:01:00.000Z" }, progress, 6_319, now)).toThrow();
    expect(() => storageRepairExecutionBoundary(migration, { ...eod, completed_input_clock: 1 }, progress, 6_319, now)).toThrow();
    expect(() => storageRepairExecutionBoundary(migration, { ...eod, stage: "publication" }, progress, 6_319, now)).toThrow();
  });
  it("rejects inconsistent checkpoint progress", () => {
    for (const value of [{ ...progress, total: 252 }, { ...progress, chunk: 253 }, { ...progress, symbols: 6_124 }, { ...progress, chunk: -1 }]) {
      expect(() => storageRepairExecutionBoundary(migration, eod, value, 6_319, now)).toThrow();
    }
  });
});
