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

  it("allows call sites to opt into a higher maximum timeout", () => {
    expect(resolveFetchTimeoutMs("240000", 15_000, 300_000)).toBe(240_000);
    expect(resolveFetchTimeoutMs("500000", 15_000, 300_000)).toBe(300_000);
  });
});
