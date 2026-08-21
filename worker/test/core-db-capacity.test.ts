import { afterEach, describe, expect, it, vi } from "vitest";

import {
  inspectCoreDatabaseSize,
  isCoreDatabaseCapacityError,
  normalizeScanStorageError,
} from "../src/core-db-capacity";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("core D1 capacity diagnostics", () => {
  it("normalizes maximum-size failures without changing unrelated errors", () => {
    expect(isCoreDatabaseCapacityError(new Error("D1_ERROR: Exceeded maximum DB size"))).toBe(true);
    expect(normalizeScanStorageError(new Error("D1_ERROR: Exceeded maximum DB size"))).toContain("previous usable snapshot remains active");
    expect(normalizeScanStorageError(new Error("TradingView unavailable"))).toBe("TradingView unavailable");
  });

  it("emits structured warning and critical capacity diagnostics", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const env = { DB: {}, CORE_DB_WARN_BYTES: "400", CORE_DB_CRITICAL_BYTES: "475" } as any;

    inspectCoreDatabaseSize(env, 399, "test");
    inspectCoreDatabaseSize(env, 450, "test");
    inspectCoreDatabaseSize(env, 490, "test");

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ database: "market_command", operation: "test", level: "warning", sizeBytes: 450 });
    expect(warn.mock.calls[1]?.[1]).toMatchObject({ database: "market_command", operation: "test", level: "critical", sizeBytes: 490 });
  });
});
