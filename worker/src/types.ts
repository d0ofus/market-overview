export type Env = {
  DB: D1Database;
  ADMIN_SECRET?: string;
  DATA_PROVIDER?: string;
  ALPACA_API_KEY?: string;
  ALPACA_API_SECRET?: string;
  ALPACA_FEED?: string;
  APP_TIMEZONE?: string;
  TRADINGVIEW_WIDGET_ENABLED?: string;
  ALERTS_RECONCILE_ENABLED?: string;
  ALERTS_MAILBOX_SYNC_URL?: string;
  ALERTS_MAILBOX_SYNC_TOKEN?: string;
  ALERTS_ENABLE_YFINANCE_FALLBACK?: string;
  ALERTS_EMAIL_ALLOWED_FROM?: string;
  FINNHUB_API_KEY?: string;
  ALPHA_VANTAGE_API_KEY?: string;
  FMP_API_KEY?: string;
  SEC_USER_AGENT?: string;
  IBKR_NEWS_ENABLED?: string;
  IBKR_NEWS_ENDPOINT?: string;
  IBKR_NEWS_TOKEN?: string;
  SCANNING_TRADINGVIEW_ENABLED?: string;
};

export type RankingWindow = "1D" | "5D" | "1W" | "YTD" | "52W";

export type MetricBundle = {
  price: number;
  change1d: number;
  change5d: number;
  change1w: number;
  change3m: number;
  change6m: number;
  change21d: number;
  ytd: number;
  pctFrom52wHigh: number;
  sparkline: number[];
};

export type DashboardConfigPayload = {
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
        order: number;
        enabled: boolean;
        tags: string[];
        holdings: string[] | null;
      }>;
    }>;
  }>;
};

export type SnapshotResponse = {
  asOfDate: string;
  generatedAt: string;
  providerLabel: string;
  config: DashboardConfigPayload;
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
        rankKey: number;
        holdings: string[] | null;
      }>;
    }>;
  }>;
};
