import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSsgaHoldingsFile, syncEtfConstituents } from "../src/etf";
import { etfHoldingAssetType, prepareStoredEtfHoldings } from "../src/etf-holdings-quality";
import type { Env } from "../src/types";
import { createSqliteD1 } from "./helpers/sqlite-d1";

const NOW = new Date("2026-09-11T08:05:00Z");
const fixtures = JSON.parse(readFileSync("test/fixtures/ssga-industry-2026-09-09.json", "utf8")) as {
  funds: Array<{ ticker: string; url: string; rows: unknown[][] }>;
};
const corporateIds = ["592CVR013", "009CVR044", "457CVR017", "604CVR027", "925CVR011", "096CVR048"];
function workbook(rows: unknown[][]): ArrayBuffer {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), "holdings");
  return XLSX.write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("dated industry holdings preserve issuer position identities", () => {
  it.each(fixtures.funds)("preserves every actual $ticker position and reported weight", fund => {
    const parsed = parseSsgaHoldingsFile(fund.ticker, workbook(fund.rows), "xlsx");
    expect(parsed.asOfDate).toBe("2026-09-09");
    expect(parsed.holdings).toHaveLength(fund.ticker === "XBI" ? 156 : 54);
    const header = fund.rows.findIndex(row => row.includes("Ticker") && row.includes("Weight"));
    expect(parsed.holdings.map(row => row.weight)).toEqual(fund.rows.slice(header + 1).map(row => Number(row[4])));
    const view = prepareStoredEtfHoldings(fund.ticker, parsed.holdings.map(row => ({ ...row, source: "ssga:fund-data",
      asOfDate: parsed.asOfDate!, updatedAt: NOW.toISOString() })), null, NOW);
    expect(view.holdings.status).toBe("ready");
    if (fund.ticker === "XBI") {
      const actions = view.rows.filter(row => row.assetType === "corporate_action");
      expect(actions.map(row => row.ticker)).toEqual(corporateIds);
      expect(actions.every(row => !row.chartEligible)).toBe(true);
      expect(view.rows.find(row => row.ticker === "USD")).toMatchObject({ assetType: "cash", weight: -0.000121, chartEligible: false });
    } else expect(view.rows.find(row => row.ticker === "IXPU6"))
      .toMatchObject({ assetType: "derivative", weight: 0.025329, chartEligible: false });
  });

  it("requires all six exact XBI names, source identifiers and fund identities", () => {
    const fund = fixtures.funds.find(row => row.ticker === "XBI")!;
    for (const id of corporateIds) {
      const position = fund.rows.find(row => row[2] === id)!;
      const holding = { ticker: id, name: String(position[0]), source: "ssga:fund-data" };
      expect(etfHoldingAssetType("XBI", holding)).toBe("corporate_action");
      expect(etfHoldingAssetType("XLP", holding)).toBe("equity");
      expect(etfHoldingAssetType("XBI", { ...holding, source: "unknown" })).toBe("equity");
      expect(etfHoldingAssetType("XBI", { ...holding, name: "Unverified company" })).toBe("equity");
      const wrong = structuredClone(fund.rows);
      wrong.find(row => row[2] === id)![2] = "UNVERIFIED";
      expect(() => parseSsgaHoldingsFile("XBI", workbook(wrong), "xlsx")).toThrow("position-identity-invalid");
    }
  });

  it("requires the verified XOP energy contract source, root and expiry", () => {
    const holding = { ticker: "IXPU6", name: "XAE ENERGY        SEP26", source: "ssga:fund-data" };
    expect(etfHoldingAssetType("XOP", holding)).toBe("derivative");
    for (const wrong of [{ ...holding, source: "unknown" }, { ...holding, ticker: "IXPZ6" }, { ...holding, ticker: "IXPU7" },
      { ...holding, ticker: "IXTU6" }, { ...holding, name: "Energy company" }]) expect(etfHoldingAssetType("XOP", wrong)).toBe("equity");
    expect(etfHoldingAssetType("XBI", holding)).toBe("equity");
  });

  it("stores the complete official lists without seeding CVRs, cash or futures as equities", async () => {
    const sqlite = createSqliteD1();
    try {
      sqlite.script("CREATE TABLE symbols(ticker TEXT PRIMARY KEY,name TEXT,exchange TEXT,asset_class TEXT,sector TEXT,industry TEXT);\n"
        + ["0006_etf_watchlists_and_constituents.sql", "0009_etf_watchlist_source_url.sql", "0051_etf_sync_metadata.sql"]
          .map(name => readFileSync(`migrations/${name}`, "utf8")).join("\n"));
      const env = { DB: sqlite.db } as Env;
      for (const fund of fixtures.funds) {
        vi.spyOn(globalThis, "fetch").mockImplementation(async input => String(input).endsWith(".xlsx")
          ? new Response(workbook(fund.rows)) : new Response(`<a href="${fund.url}">Holdings</a>`));
        await expect(syncEtfConstituents(env, fund.ticker)).resolves.toMatchObject({ sourceTier: "official", coverage: "full", asOfDate: "2026-09-09" });
        expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM etf_constituents WHERE etf_ticker=?").bind(fund.ticker).first("count"))
          .toBe(fund.ticker === "XBI" ? 156 : 54);
        vi.restoreAllMocks();
      }
      expect(await env.DB.prepare("SELECT ticker FROM symbols WHERE ticker IN (SELECT value FROM json_each(?))")
        .bind(JSON.stringify([...corporateIds, "IXPU6", "USD", "-"])).all()).toMatchObject({ results: [] });
    } finally { sqlite.dispose(); }
  }, 20_000);
});
