export type RankingWindow = "1D" | "5D" | "1W" | "YTD" | "52W";
export type QuoteFreshnessStatus = "fresh" | "stale" | "unavailable" | "unsupported";
export type BarFreshnessStatus = "fresh" | "stale" | "unavailable" | "unsupported";
export type OverviewCurrentProviderStatus = "supported" | "unsupported" | "stale" | "missing" | "rate-limited" | "auth-blocked" | "provider-error";

export type OverviewCurrentData = {
  sessionDate: string;
  status: "fresh" | "unavailable" | "retrying";
  reason: string;
  quoteSource: string | null;
  performanceSource: string | null;
  smaSource: string | null;
  fieldSources: Record<string, string>;
  providerStatuses: Record<string, {
    status: OverviewCurrentProviderStatus;
    reason: string;
    providerSymbol?: string | null;
    marketTimestamp?: string | null;
  }>;
  fetchedAt: string;
  tradingViewSymbol: string | null;
  tradingViewTime: string | null;
  tradingViewLastBarUpdateTime: string | null;
  tradingViewLastPriceUpdateTime: string | null;
  tradingViewUpdateTime: string | null;
  tradingViewUpdateMode: string | null;
  tradingViewCurrentSession: string | null;
};

export type SnapshotReadyResponse = {
  status?: "ready";
  warning?: null;
  asOfDate: string;
  generatedAt: string;
  providerLabel: string;
  expectedAsOfDate?: string | null;
  freshnessStatus?: "fresh" | "partial" | "stale";
  freshnessCoveragePct?: number | null;
  freshnessCurrentCount?: number | null;
  freshnessEligibleCount?: number | null;
  freshnessCriticalMissingTickers?: string[];
  freshnessMinBarDate?: string | null;
  freshnessMaxBarDate?: string | null;
  freshnessWarning?: string | null;
  quoteOverlayRequestedCount?: number | null;
  quoteOverlayReturnedCount?: number | null;
  quoteOverlayError?: string | null;
  quoteOverlayMissingSample?: string[];
  config: {
    id: string;
    name: string;
    timezone: string;
    eodRunLocalTime: string;
    eodRunTimeLabel: string;
    sections: Array<{
      id: string;
      title: string;
      description: string | null;
      isCollapsible: boolean;
      defaultCollapsed: boolean;
      order: number;
      groups: Array<{
        id: string;
        title: string;
        order: number;
        dataType: string;
        rankingWindowDefault: RankingWindow;
        showSparkline: boolean;
        pinTop10: boolean;
        columns: string[];
        items: Array<{
          id: string;
          ticker: string;
          displayName: string | null;
          isEtfUniverseManaged: boolean;
          etfUniverseListType: "sector" | "industry" | null;
          etfUniverseFundName: string | null;
          order: number;
          enabled: boolean;
          tags: string[];
          holdings: string[] | null;
        }>;
      }>;
    }>;
  };
  sections: Array<{
    id: string;
    title: string;
    description: string | null;
    groups: Array<{
      id: string;
      title: string;
      dataType: string;
      rankingWindowDefault: RankingWindow;
      showSparkline: boolean;
      pinTop10: boolean;
      columns: string[];
      rows: Array<{
        ticker: string;
        displayName: string | null;
        price: number | null;
        change1d: number | null;
        change1w: number | null;
        change5d: number | null;
        change3m: number | null;
        change6m: number | null;
        change21d: number | null;
        ytd: number | null;
        pctFrom52wHigh: number | null;
        sparkline: number[] | null;
        relativeStrength30dVsSpy: number[] | null;
        above20Sma: boolean | null;
        above50Sma: boolean | null;
        above200Sma: boolean | null;
        barDate?: string | null;
        barFreshnessStatus?: BarFreshnessStatus;
        barFreshnessReason?: string | null;
        quotePrice?: number | null;
        quotePrevClose?: number | null;
        quoteChange1d?: number | null;
        quoteFreshnessStatus?: QuoteFreshnessStatus;
        quoteFreshnessReason?: string | null;
        quoteSource?: string | null;
        quoteFetchedAt?: string | null;
        currentData?: OverviewCurrentData;
        historyData?: {
          sessionDate: string;
          status: BarFreshnessStatus;
          reason: string;
          barDate: string | null;
          source: string | null;
        };
        rankKey: number | null;
        holdings: string[] | null;
      }>;
    }>;
  }>;
};

export type SnapshotEmptyResponse = {
  status: "empty";
  warning: string;
  asOfDate: null;
  generatedAt: null;
  providerLabel: null;
  expectedAsOfDate?: string | null;
  freshnessStatus?: "fresh" | "partial" | "stale";
  freshnessCoveragePct?: number | null;
  freshnessCurrentCount?: number | null;
  freshnessEligibleCount?: number | null;
  freshnessCriticalMissingTickers?: string[];
  freshnessMinBarDate?: string | null;
  freshnessMaxBarDate?: string | null;
  freshnessWarning?: string | null;
  quoteOverlayRequestedCount?: number | null;
  quoteOverlayReturnedCount?: number | null;
  quoteOverlayError?: string | null;
  quoteOverlayMissingSample?: string[];
  config: null;
  sections: [];
};

export type SnapshotResponse = SnapshotReadyResponse | SnapshotEmptyResponse;
