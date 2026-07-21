import type {
  BarFreshnessStatus,
  OverviewCurrentData,
  OverviewSeriesStatus,
  QuoteFreshnessStatus,
} from "../types/dashboard";

export type OverviewFreshnessIndicatorKind =
  | "quote-retrying"
  | "quote-stale"
  | "quote-unavailable"
  | "history-lagging"
  | "history-unavailable"
  | "unsupported";

export type OverviewFreshnessIndicatorTone = "info" | "warning" | "danger";

export type OverviewFreshnessIndicatorSpec = {
  kind: OverviewFreshnessIndicatorKind;
  tone: OverviewFreshnessIndicatorTone;
  heading: string;
  detail: string;
};

export type OverviewFreshnessIndicatorRow = {
  ticker: string;
  barDate?: string | null;
  barFreshnessStatus?: BarFreshnessStatus;
  quoteFreshnessStatus?: QuoteFreshnessStatus;
  quoteFreshnessReason?: string | null;
  quoteSource?: string | null;
  quoteFetchedAt?: string | null;
  sparkline?: number[] | null;
  relativeStrength30dVsSpy?: number[] | null;
  currentData?: OverviewCurrentData;
  historyData?: {
    sessionDate: string;
    status: BarFreshnessStatus;
    reason: string;
    barDate: string | null;
    source: string | null;
    seriesThroughDate?: string | null;
    seriesStatus?: OverviewSeriesStatus;
    seriesSource?: string | null;
    seriesReason?: string | null;
  };
};

function cleanReason(value: string | null | undefined): string | null {
  const reason = value?.replace(/\s+/g, " ").trim();
  if (!reason) return null;
  if (
    reason.length > 240
    || /<\/?(?:html|body|script)\b/i.test(reason)
    || /[\[{]\s*"?(?:error|message|code)"?\s*:/i.test(reason)
  ) {
    return null;
  }
  return reason;
}

function sentence(parts: Array<string | null | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join(" ");
}

function expectedSession(row: OverviewFreshnessIndicatorRow): string | null {
  return row.currentData?.sessionDate ?? row.historyData?.sessionDate ?? null;
}

function currentDetail(row: OverviewFreshnessIndicatorRow, lead: string): string {
  const observedAt = row.quoteFetchedAt ?? row.currentData?.fetchedAt ?? null;
  const source = row.quoteSource ?? row.currentData?.quoteSource ?? null;
  return sentence([
    lead,
    observedAt ? `Last observation: ${observedAt}.` : null,
    expectedSession(row) ? `Expected session: ${expectedSession(row)}.` : null,
    source ? `Source: ${source}.` : null,
    cleanReason(row.quoteFreshnessReason ?? row.currentData?.reason),
  ]);
}

function resolvedSeriesStatus(row: OverviewFreshnessIndicatorRow): OverviewSeriesStatus | null {
  if (row.historyData?.seriesStatus) return row.historyData.seriesStatus;
  const hasUsableSeries = (row.sparkline?.length ?? 0) > 1
    || (row.relativeStrength30dVsSpy?.length ?? 0) > 1;
  if (hasUsableSeries && row.barFreshnessStatus === "stale") return "stale";
  if (hasUsableSeries) return "fresh";
  return row.barFreshnessStatus ?? null;
}

function historyLaggingDetail(row: OverviewFreshnessIndicatorRow): string {
  const throughDate = row.historyData?.seriesThroughDate ?? row.historyData?.barDate ?? null;
  const canonicalDate = row.barDate ?? row.historyData?.barDate ?? null;
  const source = row.historyData?.seriesSource ?? row.historyData?.source ?? null;
  return sentence([
    throughDate
      ? `Sparkline and 30-day RS are available through ${throughDate}.`
      : "Sparkline and 30-day RS use the latest valid stored series.",
    canonicalDate ? `The canonical daily bar is through ${canonicalDate}.` : null,
    "Displayed charts remain usable while backfill continues.",
    source ? `Source: ${source}.` : null,
  ]);
}

function historyUnavailableDetail(row: OverviewFreshnessIndicatorRow): string {
  const source = row.historyData?.seriesSource ?? row.historyData?.source ?? null;
  return sentence([
    "Sparkline and 30-day RS are not currently available.",
    expectedSession(row) ? `Expected session: ${expectedSession(row)}.` : null,
    source ? `Source: ${source}.` : null,
    cleanReason(row.historyData?.seriesReason ?? row.historyData?.reason),
  ]);
}

export function getOverviewFreshnessIndicators(
  row: OverviewFreshnessIndicatorRow,
): OverviewFreshnessIndicatorSpec[] {
  const seriesStatus = resolvedSeriesStatus(row);
  if (row.quoteFreshnessStatus === "unsupported" || seriesStatus === "unsupported") {
    return [{
      kind: "unsupported",
      tone: "info",
      heading: "Instrument unsupported",
      detail: sentence([
        `${row.ticker} is not supported by the configured current or historical data providers.`,
        "This is informational and is not counted as a freshness error.",
      ]),
    }];
  }

  const indicators: OverviewFreshnessIndicatorSpec[] = [];
  if (row.currentData?.status === "retrying") {
    indicators.push({
      kind: "quote-retrying",
      tone: "warning",
      heading: "Data refresh in progress",
      detail: currentDetail(row, "A scheduled refresh is running. Last valid current values remain visible where available."),
    });
  } else if (row.quoteFreshnessStatus === "unavailable" || row.currentData?.status === "unavailable") {
    indicators.push({
      kind: "quote-unavailable",
      tone: "danger",
      heading: "Current quote unavailable",
      detail: currentDetail(row, "Current price and one-day change are not available."),
    });
  } else if (row.quoteFreshnessStatus === "stale") {
    indicators.push({
      kind: "quote-stale",
      tone: "warning",
      heading: "Current quote is stale",
      detail: currentDetail(row, "The displayed current quote is older than the expected market session."),
    });
  }

  if (seriesStatus === "unavailable") {
    indicators.push({
      kind: "history-unavailable",
      tone: "danger",
      heading: "Chart history unavailable",
      detail: historyUnavailableDetail(row),
    });
  } else if (seriesStatus === "fallback" || seriesStatus === "stale") {
    indicators.push({
      kind: "history-lagging",
      tone: "warning",
      heading: "Charts use fallback history",
      detail: historyLaggingDetail(row),
    });
  }

  return indicators.slice(0, 2);
}
