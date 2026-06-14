export type MarketSession = "premarket" | "regular" | "after-hours";
export type AlertsSessionFilter = MarketSession | "all";

export type InboundEmailPayload = {
  messageId?: string | null;
  subject?: string | null;
  from?: string | null;
  receivedAt?: string | null;
  text?: string | null;
  html?: string | null;
  headers?: Record<string, string | string[] | null | undefined> | null;
  rawPayload?: unknown;
  sourceMailbox?: string | null;
};

export type ParsedTradingViewAlert = {
  ticker: string;
  alertType: string | null;
  strategyName: string | null;
  messageBody: string;
  metadata: Record<string, string>;
};

export type AlertFilterInput = {
  startDate?: string | null;
  endDate?: string | null;
  session?: string | null;
  limit?: number | null;
  offset?: number | null;
};

export type NormalizedAlertFilters = {
  startDate: string;
  endDate: string;
  session: AlertsSessionFilter;
  limit: number;
};

export type AlertLogRow = {
  id: string;
  ticker: string;
  alertType: string | null;
  strategyName: string | null;
  rawPayload: string | null;
  rawEmailSubject: string | null;
  rawEmailFrom: string | null;
  rawEmailReceivedAt: string | null;
  receivedAt: string;
  marketSession: MarketSession;
  tradingDay: string;
  source: string;
  createdAt: string;
};

export type TickerNewsRow = {
  id: string;
  ticker: string;
  tradingDay: string;
  headline: string;
  source: string;
  url: string;
  publishedAt: string | null;
  snippet: string | null;
  fetchedAt: string;
};

export type AlertTickerDayRow = {
  ticker: string;
  tradingDay: string;
  latestReceivedAt: string;
  alertCount: number;
  marketSession: MarketSession;
  price: number | null;
  change1d: number | null;
  industry: string | null;
  marketCap: number | null;
  avgVolume: number | null;
  priceAvgVolume: number | null;
  news: TickerNewsRow[];
};

export type IngestAlertResult = {
  emailId: string;
  alertId: string | null;
  messageId: string;
  status: "ingested" | "duplicate" | "parse_failed";
  ticker: string | null;
  tradingDay: string | null;
  newsInserted: number;
  error?: string;
};

export type ReconcileAlertsResult = {
  adaptersChecked: number;
  emailsPulled: number;
  alertsIngested: number;
  duplicates: number;
  parseFailures: number;
};

export type AlertIngestionRuntimeConfig = {
  housekeepingEnabled?: boolean;
  reconcileEnabled?: boolean;
  retentionDays?: number;
  staleAfterHours?: number;
};

export type AlertIngestionStatus = {
  generatedAt: string;
  totals: {
    alerts: number;
    emails: number;
  };
  latestAlert: {
    id: string;
    ticker: string;
    receivedAt: string;
    tradingDay: string;
    marketSession: MarketSession;
    rawEmailSubject: string | null;
  } | null;
  latestEmail: {
    id: string;
    messageId: string;
    sourceMailbox: string | null;
    parseStatus: string;
    rawEmailSubject: string | null;
    rawEmailFrom: string | null;
    rawEmailReceivedAt: string | null;
    createdAt: string;
    parseError: string | null;
  } | null;
  parseStatuses: Array<{
    parseStatus: string;
    count: number;
    latestRawEmailReceivedAt: string | null;
    latestCreatedAt: string | null;
  }>;
  sourceMailboxes: Array<{
    sourceMailbox: string | null;
    count: number;
    latestCreatedAt: string | null;
  }>;
  config: {
    directEmailHandlerEnabled: boolean;
    mailboxSyncConfigured: boolean;
    mailboxSyncAdapters: string[];
    reconcileEnabled: boolean;
    housekeepingEnabled: boolean;
    retentionDays: number;
    staleAfterHours: number;
  };
  stale: {
    isStale: boolean;
    latestAlertAgeHours: number | null;
    latestEmailAgeHours: number | null;
    staleBasis: "latest_email" | "latest_alert" | "none";
  };
};

