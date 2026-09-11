import { describe, expect, it } from "vitest";
import { storageListingExecutionBoundary } from "../src/market-storage-listing-execution";

const now = new Date("2026-09-11T18:14:00.000Z");
const migration = { status: "queued" as const, stage: "bootstrap", error_code: null, next_attempt_at: now.toISOString(), updated_at: now.toISOString() };
const eod = { id: "eod:active:2026-09-10:daily", input_json: "{}", progress_json: "{}", status: "retrying", stage: "prices",
  mode: "active", purpose: "daily", error_code: "runner-error", error_message: "storage-run-time-slice-complete",
  next_attempt_at: now.toISOString(), updated_at: now.toISOString() };
const progress = { total: 253, chunk: 129, symbols: 3_250 };

describe("listing continuation admits only the preserved planned boundary", () => {
  it("preserves the exact due time for prices or publication and never creates a new cooldown", () => {
    expect(storageListingExecutionBoundary(migration, eod, progress, 6_319, now)).toEqual({ kind: "prices",
      resume: { status: "queued", errorCode: null, nextAttemptAt: now.toISOString() } });
    expect(storageListingExecutionBoundary(migration, { ...eod, stage: "publication" }, { symbols: 6_319 }, 6_319, now).kind).toBe("publication");
  });
  it.each(["provider-error", "resource-budget", "incomplete-publication"])("rejects %s retries even when due", error => {
    expect(() => storageListingExecutionBoundary(migration, { ...eod, error_code: error }, progress, 6_319, now)).toThrow("planned-slice-required");
  });
  it("rejects future retry, incomplete migration, unplanned errors and out-of-range progress", () => {
    expect(() => storageListingExecutionBoundary(migration, { ...eod, next_attempt_at: "2026-09-11T18:15:00.000Z" }, progress, 6_319, now)).toThrow();
    expect(() => storageListingExecutionBoundary({ ...migration, status: "retrying", error_code: "storage-bootstrap-incomplete" }, eod, progress, 6_319, now)).toThrow();
    expect(() => storageListingExecutionBoundary(migration, { ...eod, error_message: "worker-interrupted" }, progress, 6_319, now)).toThrow();
    expect(() => storageListingExecutionBoundary(migration, eod, { ...progress, chunk: 253 }, 6_319, now)).toThrow();
    expect(() => storageListingExecutionBoundary(migration, { ...eod, stage: "publication" }, { symbols: 6_318 }, 6_319, now)).toThrow();
  });
});
