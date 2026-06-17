import { describe, expect, it } from "vitest";
import { resolveFetchTimeoutMs } from "../src/timeout";

describe("fetch timeout config", () => {
  it("uses default timeout when env value is missing or invalid", () => {
    expect(resolveFetchTimeoutMs(undefined, 15_000)).toBe(15_000);
    expect(resolveFetchTimeoutMs("not-a-number", 15_000)).toBe(15_000);
    expect(resolveFetchTimeoutMs("0", 15_000)).toBe(15_000);
  });

  it("clamps configured timeout to a sane range", () => {
    expect(resolveFetchTimeoutMs("500", 15_000)).toBe(1_000);
    expect(resolveFetchTimeoutMs("300000", 15_000)).toBe(120_000);
    expect(resolveFetchTimeoutMs("20000", 15_000)).toBe(20_000);
  });
});
