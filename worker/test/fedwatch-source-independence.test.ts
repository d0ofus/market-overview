import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";

const sources = vi.hoisted(() => ({
  loadOfficialRateFacts: vi.fn(), refreshOfficialRateFacts: vi.fn(),
  loadLatestFomcCommentary: vi.fn(), loadOrRefreshLatestFomcCommentary: vi.fn(),
}));
vi.mock("../src/official-rates-service", () => sources);
vi.mock("../src/fomc-commentary-service", () => sources);
const { refreshFedWatchSnapshot } = await import("../src/fedwatch-service");

describe("independent official rate facts", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
  it("returns refreshed official rates and official commentary when the probability provider blocks access", async () => {
    sources.loadOfficialRateFacts.mockResolvedValue({ officialRates: null, officialRatesWarning: "No previous observation." });
    sources.loadLatestFomcCommentary.mockResolvedValue([]);
    const officialRates = { source: "new-york-fed", sourceUrl: "https://markets.newyorkfed.org/api/rates/unsecured/effr/last/1.json",
      effectiveDate: "2026-09-04", fetchedAt: "2026-09-08T13:00:00Z", effr: 3.63, targetLower: 3.5, targetUpper: 3.75 };
    const officialCommentary = [{ id: "official-statement", sourceUrl: "https://www.federalreserve.gov/monetarypolicy.htm" }];
    sources.refreshOfficialRateFacts.mockResolvedValue({ officialRates, officialRatesWarning: null });
    sources.loadOrRefreshLatestFomcCommentary.mockResolvedValue(officialCommentary);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Challenge required", { status: 403 })));
    const run = vi.fn();
    const env = { DB: { prepare: () => ({ first: async () => null, run }) } } as unknown as Env;

    const response = await refreshFedWatchSnapshot(env);

    expect(response).toMatchObject({ status: "unavailable", data: null, officialRates, fomcCommentary: officialCommentary });
    expect(response.warning).toContain("403");
    expect(sources.refreshOfficialRateFacts).toHaveBeenCalledWith(env);
    expect(sources.loadOrRefreshLatestFomcCommentary).toHaveBeenCalledWith(env, 4);
    expect(run).not.toHaveBeenCalled(); // No fabricated probability snapshot is persisted.
  });
});
