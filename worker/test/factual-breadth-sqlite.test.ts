import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildFactualDailyReport, buildFactualWeeklyReport, loadFactualBreadthEvidence } from "../src/factual-market-report";
import { storeEodPublication } from "../src/eod-publication-service";
import type { Env } from "../src/types";
import { createSqliteD1 } from "./helpers/sqlite-d1";

describe("accepted breadth evidence against real SQLite", { timeout: 15_000 }, () => {
  let market: ReturnType<typeof createSqliteD1>;
  let env: Env;
  const sessionDate = "2026-09-08";
  beforeEach(() => {
    market = createSqliteD1(); market.migrate("market-data-migrations");
    env = { DB: market.db, MARKET_DATA_DB: market.db, EOD_READ_ENABLED: "true" } as Env;
  }, 30_000);
  afterEach(() => market.dispose());
  const payload = (universeId: string, date = sessionDate, advancers = 123) => ({
    asOfDate: date, universeId, dataSource: "Alpaca SIP / validated Yahoo fallback",
    metrics: { totalUniverseMembers: 500, advancers, pctAbove200MA: 999,
      metricCoverage: { advancers: { status: "ready", eligibleCount: 490, eligiblePopulation: 500, missingCount: 10,
        lowerBound: advancers, upperBound: advancers + 10, boundUnit: "count" },
      pctAbove200MA: { status: "suppressed", eligibleCount: 300, eligiblePopulation: 500, missingCount: 200 } } },
    membership: { source: "Declared membership provider", sourceType: "holdings-proxy", sourceAsOfDate: date,
      verifiedAt: `${date}T20:30:00Z`, sourceUrl: "https://example.test/membership" },
  });
  const store = (universe: string, date: string, value = 123, promote = true) => storeEodPublication(env, {
    scope: `breadth:${universe}`, sessionDate: date, inputHash: `${universe}:${date}:${value}`, methodologyVersion: "test",
    payload: payload(universe, date, value), promote, revisions: [],
  });

  it("uses latest accepted revisions for the requested date, excludes candidates/other sessions, and retains metric suppression", async () => {
    await store("sp500-core", sessionDate, 100);
    const currentId = await store("sp500-core", sessionDate, 123);
    await store("sp500-core", sessionDate, 777, false);
    await store("nasdaq-core", "2026-09-04", 900);
    const evidence = await loadFactualBreadthEvidence(env, sessionDate, "overview-used");
    expect(evidence.publicationIds).toMatchObject({ "overview:default": "overview-used", "breadth:sp500-core": currentId, "breadth:nasdaq-core": null });
    expect(Object.keys(evidence.publicationIds)).toHaveLength(6);
    expect(evidence.summary).toContain("advancers: 123.00");
    expect(evidence.summary).toContain("observed 490/500 eligible; unresolved 10; bounds 123.00–133.00 count");
    expect(evidence.summary).toContain("above 200-session SMA: N/A");
    expect(evidence.summary).toContain("type holdings-proxy");
    expect(evidence.summary).toContain("NASDAQ universe: unavailable for 2026-09-08");
    expect(evidence.summary).not.toContain("777.00"); expect(evidence.summary).not.toContain("900.00"); expect(evidence.summary).not.toContain("999.00");
    const common = { dashboardSummary: "Overview", breadthSummary: evidence.summary, fedWatchSummary: "Rates unavailable",
      sourceAudit: evidence.sourceAudit, dataQuality: evidence.dataQuality, reason: "AI unavailable" };
    const daily = buildFactualDailyReport({ ...common, sessionDate, sessionLabel: "US close" });
    const weekly = buildFactualWeeklyReport({ ...common, weekStart: "2026-09-07", weekEnd: sessionDate, recentDailyCommentarySummary: "" });
    expect(daily).toContain("advancers: 123.00"); expect(daily.match(/^## /gm)).toHaveLength(18);
    expect(weekly).toContain("advancers: 123.00"); expect(weekly.match(/^## /gm)).toHaveLength(9);
    expect(weekly).toContain("not weekly changes in breadth");
  });

  it("changes report identity on breadth catch-up and suppresses a corrupted accepted payload", async () => {
    const empty = await loadFactualBreadthEvidence(env, sessionDate, "overview-used");
    const id = await store("nyse-core", sessionDate);
    const complete = await loadFactualBreadthEvidence(env, sessionDate, "overview-used");
    expect(complete.identity).not.toBe(empty.identity);
    expect(complete.publicationIds["overview:default"]).toBe(empty.publicationIds["overview:default"]);
    await market.db.prepare("UPDATE eod_publications SET payload_checksum='incorrect' WHERE id=?").bind(id).run();
    const invalid = await loadFactualBreadthEvidence(env, sessionDate, "overview-used");
    expect(invalid.publicationIds["breadth:nyse-core"]).toBeNull();
    expect(invalid.summary).toContain("identity/checksum could not be verified");
    expect(invalid.summary).not.toContain("advancers: 123.00");
  });
});
