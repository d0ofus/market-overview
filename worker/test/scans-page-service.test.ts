import { describe, expect, it, vi } from "vitest";
import {
  buildTradingViewScanPayload,
  fetchTradingViewScanRows,
  normalizeScanRows,
  type ScanPreset,
} from "../src/scans-page-service";

const topGainersPreset: ScanPreset = {
  id: "scan-preset-top-gainers",
  name: "Top Gainers",
  isDefault: true,
  isActive: true,
  rules: [
    { id: "close", field: "close", operator: "gt", value: 1 },
    { id: "change", field: "change", operator: "gt", value: 3 },
    { id: "type", field: "type", operator: "in", value: ["stock", "dr"] },
    { id: "exchange", field: "exchange", operator: "in", value: ["NASDAQ", "NYSE", "AMEX"] },
    { id: "volume", field: "volume", operator: "gt", value: 100000 },
    { id: "traded", field: "Value.Traded", operator: "gt", value: 10000000 },
    {
      id: "industry",
      field: "industry",
      operator: "not_in",
      value: [
        "Biotechnology",
        "Pharmaceuticals: generic",
        "Pharmaceuticals: major",
        "Pharmaceuticals: other",
      ],
    },
  ],
  sortField: "change",
  sortDirection: "desc",
  rowLimit: 100,
  createdAt: "",
  updatedAt: "",
};

describe("scans page service", () => {
  it("normalizes rows, computes price * avg volume fallback, and sorts by 1D change descending", () => {
    const rows = normalizeScanRows([
      {
        ticker: "NASDAQ:MSFT",
        name: "Microsoft",
        sector: "Technology",
        industry: "Software",
        change1d: 4.2,
        marketCap: 3_000_000_000_000,
        relativeVolume: 1.3,
        price: 420,
        avgVolume: 20_000_000,
      },
      {
        ticker: "nyse:abc",
        name: "ABC Corp",
        sector: "Industrials",
        industry: "Machinery",
        change1d: 8.5,
        marketCap: "1200000000",
        relativeVolume: "2.75",
        price: "12.5",
        avgVolume: "2500000",
        raw: { source: "tv" },
      },
      {
        ticker: "",
        name: "Invalid",
        change1d: 99,
      },
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      ticker: "ABC",
      name: "ABC Corp",
      change1d: 8.5,
      marketCap: 1_200_000_000,
      price: 12.5,
      avgVolume: 2_500_000,
      relativeVolume: 2.75,
      priceAvgVolume: 31_250_000,
    });
    expect(rows[1]).toMatchObject({
      ticker: "MSFT",
      name: "Microsoft",
      relativeVolume: 1.3,
      priceAvgVolume: 8_400_000_000,
    });
  });

  it("builds a tradingview payload that pushes numeric rules upstream and expands fetch size for post-filters", () => {
    const payload = buildTradingViewScanPayload(topGainersPreset);

    expect(payload.sort).toEqual({ sortBy: "change", sortOrder: "desc" });
    expect(payload.range).toEqual([0, 300]);
    expect(payload.filter).toEqual([
      { left: "close", operation: "greater", right: 1 },
      { left: "change", operation: "greater", right: 3 },
      { left: "volume", operation: "greater", right: 100000 },
      { left: "Value.Traded", operation: "greater", right: 10000000 },
    ]);
  });

  it("applies string post-filters after the TradingView response is parsed", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            s: "NASDAQ:NVDA",
            d: ["NVIDIA", "Technology", "Semiconductors", 5.7, 2_000_000_000_000, 1.8, 910, 45_000_000, 40_950_000_000, 60_000_000, "NASDAQ", "stock"],
          },
          {
            s: "NASDAQ:BIOX",
            d: ["Bio X", "Health Care", "Biotechnology", 2_500_000_000, 1.1, 6.2, 9.4, 4_000_000, 37_600_000, 8_000_000, "NASDAQ", "stock"],
          },
          {
            s: "OTC:OTCC",
            d: ["OTC Co", "Technology", "Software", 8.2, 900_000_000, 0.8, 5.5, 2_000_000, 11_000_000, 3_000_000, "OTC", "stock"],
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchTradingViewScanRows(topGainersPreset);

    expect(result.status).toBe("ok");
    expect(result.rows.map((row) => row.ticker)).toEqual(["NVDA"]);
    expect(result.rows[0]?.relativeVolume).toBe(1.8);
    vi.unstubAllGlobals();
  });
});
