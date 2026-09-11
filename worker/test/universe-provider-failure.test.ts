import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadNasdaqTraderUniverses, loadRussell2000Universe, loadSp500Universe } from "../src/universe-constituents";
import { meteredFetchWithRetry, ProviderBudgetExceededError, ProviderBudgetUnavailableError } from "../src/provider-usage";
import type { Env } from "../src/types";

vi.mock("../src/provider-usage", async (original) => ({
  ...await original<typeof import("../src/provider-usage")>(), meteredFetchWithRetry: vi.fn(),
}));
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe("membership provider request boundaries", () => {
  it.each([loadNasdaqTraderUniverses, (env: Env) => loadSp500Universe(undefined, env),
    (env: Env) => loadRussell2000Universe(undefined, env)])("uses a single metered attempt per requested endpoint", async (load) => {
    vi.mocked(meteredFetchWithRetry).mockRejectedValue(new ProviderBudgetExceededError("source", 4, "day"));
    await expect(load({} as Env)).rejects.toBeInstanceOf(ProviderBudgetExceededError);
    expect(meteredFetchWithRetry).toHaveBeenCalledTimes(1);
    expect(vi.mocked(meteredFetchWithRetry).mock.calls[0]?.slice(-2)).toEqual([15_000, 1]);
  });
  it.each([new ProviderBudgetUnavailableError("source"), new Error("D1_ERROR: query budget exhausted")])(
    "propagates infrastructure failure without bundled substitution or issuer discovery (%s)", async (error) => {
      vi.mocked(meteredFetchWithRetry).mockRejectedValue(error);
      await expect(loadSp500Universe(undefined, {} as Env)).rejects.toBe(error);
      await expect(loadRussell2000Universe(undefined, {} as Env)).rejects.toBe(error);
      expect(meteredFetchWithRetry).toHaveBeenCalledTimes(2);
    },
  );
  it("dates a verified S&P current list in New York after UTC midnight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T00:15:00Z"));
    const csv = ["Symbol,Security", ...Array.from({ length: 500 }, (_, index) => `T${index},Member ${index}`)].join("\n");
    vi.mocked(meteredFetchWithRetry).mockResolvedValue(new Response(csv));
    expect((await loadSp500Universe(undefined, {} as Env)).sourceAsOfDate).toBe("2026-09-10");
  });
});
