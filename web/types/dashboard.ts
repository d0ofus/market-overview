export type RankingWindow = "1D" | "5D" | "1W" | "YTD" | "52W";

export type SnapshotResponse = {
  asOfDate: string;
  generatedAt: string;
  providerLabel: string;
  config: {
    id: string;
    name: string;
    timezone: string;
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
        change21d: number;
        ytd: number;
        pctFrom52wHigh: number;
        sparkline: number[];
        rankKey: number;
        holdings: string[] | null;
      }>;
    }>;
  }>;
};
