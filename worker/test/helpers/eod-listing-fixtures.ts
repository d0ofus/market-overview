import type { ListingEvidenceImport } from "../../src/eod-listing-evidence";
import type { DashboardConfigPayload } from "../../src/types";

export const listingDashboardFixture = (tickers: string[]): DashboardConfigPayload => ({
  id: "default", name: "Market", timezone: "America/New_York", eodRunLocalTime: "16:20", eodRunTimeLabel: "After close",
  sections: [{ id: "s", title: "Market", description: null, isCollapsible: false, defaultCollapsed: false, order: 0,
    groups: [{ id: "g", title: "All", order: 0, dataType: "price", rankingWindowDefault: "1D", showSparkline: true,
      pinTop10: false, columns: [], items: tickers.map((ticker, order) => ({ id: ticker, ticker, enabled: true,
        displayName: ticker, holdings: [], order, tags: [], isEtfUniverseManaged: false, etfUniverseListType: null, etfUniverseFundName: null })) }] }],
});

/** Synthetic transport fixture for the already reviewed official claim. */
export const listingFixture = (): ListingEvidenceImport => ({ version: 1, event: "initial-listing",
  security: { ticker: "BRTM", issuerName: "B&R Technology Merger Corp.", exchange: "NASDAQ", assetClass: "equity", priorSymbols: [], issuerCik: "2131350" },
  listingDate: "2026-09-10", sourcePublishedDate: "2026-09-08", effectiveFromSession: "2026-09-11",
  sourceUrl: "https://www.sec.gov/Archives/edgar/data/2131350/000119312526385209/d102609dex991.htm", sourceDateText: "September 10, 2026", sourcePublishedDateText: "September 8, 2026",
  sourceQuote: "B&R Technology Merger Corp. announces the separate trading of its Class A ordinary shares and warrants, commencing September 10, 2026. Published September 8, 2026. The common shares trade as BRTM.", supersedesHash: null });
