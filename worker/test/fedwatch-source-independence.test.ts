import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";
import { createSqliteD1 } from "./helpers/sqlite-d1";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
    const storage=createSqliteD1();
    storage.script(readFileSync(resolve("migrations/0016_fedwatch_snapshots.sql"),"utf8")+readFileSync(resolve("migrations/0078_provider_usage_budget.sql"),"utf8"));
    const env = { DB:storage.db } as Env;
    try {
    const response = await refreshFedWatchSnapshot(env);

    expect(response).toMatchObject({ status: "unavailable", data: null, officialRates, fomcCommentary: officialCommentary });
    expect(response.warning).toContain("403");
    expect(sources.refreshOfficialRateFacts).toHaveBeenCalledWith(env);
    expect(sources.loadOrRefreshLatestFomcCommentary).toHaveBeenCalledWith(env, 4);
    expect(await storage.db.prepare("SELECT COUNT(*) AS count FROM fedwatch_snapshots").first<number>("count")).toBe(0);
    expect(response.probabilitySource).toMatchObject({error:"rateprobability-http-403",status:"cooldown"});
    } finally {storage.dispose();}
  });
});
