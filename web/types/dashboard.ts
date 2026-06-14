export type RankingWindow = "1D" | "5D" | "1W" | "YTD" | "52W";

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
        price: number;
        change1d: number;
        change1w: number;
        change5d: number;
        change3m: number;
        change6m: number;
        change21d: number;
        ytd: number;
        pctFrom52wHigh: number;
        sparkline: number[];
        relativeStrength30dVsSpy: number[] | null;
        above20Sma: boolean | null;
        above50Sma: boolean | null;
        above200Sma: boolean | null;
        barDate?: string | null;
        rankKey: number;
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
  config: null;
  sections: [];
};

export type SnapshotResponse = SnapshotReadyResponse | SnapshotEmptyResponse;
