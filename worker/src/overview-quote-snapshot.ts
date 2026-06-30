import { fetchYahooQuoteSnapshots, getProvider, type QuoteSnapshot } from "./provider";
import { zonedParts } from "./refresh-timing";
import type { BarFreshnessStatus, Env, QuoteFreshnessStatus } from "./types";

const OVERVIEW_QUOTE_UNSUPPORTED_TICKERS = new Set([
  "BKX",
  "INSR",
  "OSX",
  "XAU",
  "XNG",
]);

export type OverviewQuoteOverlay = {
  ticker: string;
  quotePrice: number | null;
  quotePrevClose: number | null;
  quoteChange1d: number | null;
  quoteSource: string | null;
  quoteFetchedAt: string | null;
  quoteFreshnessStatus: QuoteFreshnessStatus;
  quoteFreshnessReason: string;
  barFreshnessStatus: BarFreshnessStatus;
  barFreshnessReason: string;
};

export type OverviewQuoteOverlayInput = {
  ticker: string;
  groupTitle: string;
  barDate: string | null;
  expectedAsOfDate: string;
  snapshot: QuoteSnapshot | null | undefined;
};

export function isOverviewQuoteEligibleTicker(ticker: string, groupTitle: string): boolean {
  const normalized = ticker.trim().toUpperCase();
  const title = groupTitle.trim().toLowerCase();
  if (!normalized) return false;
  if (title.includes("crypto")) return false;
  if (normalized.includes("!") || normalized.includes("=")) return false;
  if (normalized.startsWith("^")) return false;
  if (OVERVIEW_QUOTE_UNSUPPORTED_TICKERS.has(normalized)) return false;
  return true;
}

function barFreshnessDiagnostic(ticker: string, barDate: string | null, expectedAsOfDate: string): { status: BarFreshnessStatus; reason: string } {
  if (!barDate) {
    return {
      status: "unavailable",
      reason: `No stored daily bar is available for ${ticker}.`,
    };
  }
  if (barDate === expectedAsOfDate) {
    return {
      status: "fresh",
      reason: `Stored daily bar is current for ${expectedAsOfDate}.`,
    };
  }
  return {
    status: "stale",
    reason: `Last stored daily bar is ${barDate}; expected ${expectedAsOfDate}.`,
  };
}

function quoteSnapshotSourceLabel(source: string): string {
  if (source === "alpaca-snapshot") return "Alpaca snapshot";
  if (source === "yahoo-chart") return "Yahoo chart/quote";
  return source;
}

function quoteSnapshotMarketDate(snapshot: QuoteSnapshot): string | null {
  const timestamp = snapshot.tradeTimestamp ?? snapshot.dailyBarTimestamp ?? snapshot.fetchedAt;
  if (!timestamp) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return zonedParts(date, "America/New_York").localDate;
}

function quoteSnapshotFreshness(snapshot: QuoteSnapshot, expectedAsOfDate: string): { status: QuoteFreshnessStatus; reason: string } {
  const quoteDate = quoteSnapshotMarketDate(snapshot);
  if (!quoteDate) {
    return {
      status: "stale",
      reason: "Snapshot quote is missing a usable provider timestamp.",
    };
  }
  if (quoteDate < expectedAsOfDate) {
    return {
      status: "stale",
      reason: `Snapshot quote timestamp is ${quoteDate}; expected ${expectedAsOfDate}.`,
    };
  }
  return {
    status: "fresh",
    reason: "Snapshot quote is current.",
  };
}

export function deriveOverviewQuoteOverlayFromSnapshot(input: OverviewQuoteOverlayInput): OverviewQuoteOverlay {
  const ticker = input.ticker.trim().toUpperCase();
  const barDate = input.barDate ?? null;
  const barFreshness = barFreshnessDiagnostic(ticker, barDate, input.expectedAsOfDate);
  if (!isOverviewQuoteEligibleTicker(ticker, input.groupTitle)) {
    return {
      ticker,
      quotePrice: null,
      quotePrevClose: null,
      quoteChange1d: null,
      quoteSource: null,
      quoteFetchedAt: null,
      quoteFreshnessStatus: "unsupported",
      quoteFreshnessReason: barDate
        ? `${ticker} is outside automated quote freshness validation; last stored daily bar is ${barDate}.`
        : `${ticker} is outside automated quote freshness validation and has no stored daily bar from current sources.`,
      barFreshnessStatus: barFreshness.status,
      barFreshnessReason: barFreshness.reason,
    };
  }

  const snapshot = input.snapshot ?? null;
  if (snapshot) {
    const sourceLabel = quoteSnapshotSourceLabel(snapshot.source);
    const quoteFreshness = quoteSnapshotFreshness(snapshot, input.expectedAsOfDate);
    return {
      ticker,
      quotePrice: snapshot.price,
      quotePrevClose: snapshot.prevClose,
      quoteChange1d: snapshot.change1d,
      quoteSource: snapshot.source,
      quoteFetchedAt: snapshot.fetchedAt,
      quoteFreshnessStatus: quoteFreshness.status,
      quoteFreshnessReason: `${sourceLabel} quote is available. ${quoteFreshness.reason}`,
      barFreshnessStatus: barFreshness.status,
      barFreshnessReason: barFreshness.reason,
    };
  }

  return {
    ticker,
    quotePrice: null,
    quotePrevClose: null,
    quoteChange1d: null,
    quoteSource: null,
    quoteFetchedAt: null,
    quoteFreshnessStatus: "unavailable",
    quoteFreshnessReason: `No Alpaca or Yahoo snapshot quote is available for ${ticker}.`,
    barFreshnessStatus: barFreshness.status,
    barFreshnessReason: barFreshness.reason,
  };
}

export type OverviewQuoteOverlayDiagnostics = {
  requestedTickers: number;
  eligibleTickers: number;
  returnedSnapshots: number;
  quotePriceRows: number;
  providerAttempted: boolean;
  providerError: string | null;
  sampleMissingTickers: string[];
};

export type OverviewQuoteOverlayResult = {
  overlays: Map<string, OverviewQuoteOverlay>;
  diagnostics: OverviewQuoteOverlayDiagnostics;
};

export type OverviewQuoteSnapshotFetchResult = {
  snapshots: Record<string, QuoteSnapshot>;
  providerAttempted: boolean;
  providerError: string | null;
};

function quoteOverlayErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "Overview quote snapshot refresh failed.");
  return message.slice(0, 500);
}

function normalizeOverviewQuoteRows(
  rows: Array<{ ticker: string; groupTitle: string; barDate: string | null }>,
): Array<{ ticker: string; groupTitle: string; barDate: string | null }> {
  return Array.from(
    new Map(rows.map((row) => [row.ticker.trim().toUpperCase(), { ...row, ticker: row.ticker.trim().toUpperCase() }])).values(),
  );
}

function eligibleOverviewQuoteTickers(
  rows: Array<{ ticker: string; groupTitle: string }>,
): string[] {
  return rows
    .filter((row) => isOverviewQuoteEligibleTicker(row.ticker, row.groupTitle))
    .map((row) => row.ticker);
}

export async function fetchOverviewQuoteSnapshots(
  env: Env,
  tickers: string[],
  expectedAsOfDate?: string | null,
): Promise<OverviewQuoteSnapshotFetchResult> {
  const uniqueTickers = Array.from(new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean)));
  let providerAttempted = false;
  const providerErrors: string[] = [];
  let snapshots: Record<string, QuoteSnapshot> = {};
  if (uniqueTickers.length === 0) {
    return { snapshots, providerAttempted, providerError: null };
  }
  try {
    const provider = getProvider(env);
    providerAttempted = Boolean(provider.getQuoteSnapshot);
    snapshots = provider.getQuoteSnapshot ? await provider.getQuoteSnapshot(uniqueTickers) : {};
  } catch (error) {
    providerErrors.push(quoteOverlayErrorMessage(error));
    console.error("overview Alpaca quote snapshot refresh failed; trying Yahoo fallback", error);
  }

  const providerMode = (env.DATA_PROVIDER ?? "alpaca").toLowerCase();
  const yahooFallbackEnabled = providerMode !== "synthetic" && providerMode !== "csv";
  const missingTickers = uniqueTickers.filter((ticker) => {
    const snapshot = snapshots[ticker];
    if (!snapshot) return true;
    return Boolean(expectedAsOfDate && quoteSnapshotFreshness(snapshot, expectedAsOfDate).status !== "fresh");
  });
  if (yahooFallbackEnabled && missingTickers.length > 0) {
    try {
      providerAttempted = true;
      const yahooSnapshots = await fetchYahooQuoteSnapshots(env, missingTickers, expectedAsOfDate);
      snapshots = { ...snapshots, ...yahooSnapshots };
    } catch (error) {
      providerErrors.push(quoteOverlayErrorMessage(error));
      console.error("overview Yahoo quote snapshot fallback failed", error);
    }
  }
  return {
    snapshots,
    providerAttempted,
    providerError: providerErrors.length > 0 ? providerErrors.join(" | ").slice(0, 500) : null,
  };
}

export function buildOverviewQuoteOverlaysFromSnapshots(
  rows: Array<{ ticker: string; groupTitle: string; barDate: string | null }>,
  expectedAsOfDate: string,
  snapshotResult: OverviewQuoteSnapshotFetchResult,
): OverviewQuoteOverlayResult {
  const uniqueRows = normalizeOverviewQuoteRows(rows);
  const eligibleTickers = uniqueRows
    .filter((row) => isOverviewQuoteEligibleTicker(row.ticker, row.groupTitle))
    .map((row) => row.ticker);
  const snapshots = snapshotResult.snapshots;

  const overlays = new Map<string, OverviewQuoteOverlay>();
  let quotePriceRows = 0;
  for (const row of uniqueRows) {
    const overlay = deriveOverviewQuoteOverlayFromSnapshot({
      ticker: row.ticker,
      groupTitle: row.groupTitle,
      barDate: row.barDate,
      expectedAsOfDate,
      snapshot: snapshots[row.ticker] ?? null,
    });
    if (overlay.quotePrice != null) quotePriceRows += 1;
    overlays.set(row.ticker, overlay);
  }

  const missingSnapshotSet = new Set(eligibleTickers.filter((ticker) => !snapshots[ticker]));
  return {
    overlays,
    diagnostics: {
      requestedTickers: uniqueRows.length,
      eligibleTickers: eligibleTickers.length,
      returnedSnapshots: Object.keys(snapshots).length,
      quotePriceRows,
      providerAttempted: snapshotResult.providerAttempted,
      providerError: snapshotResult.providerError,
      sampleMissingTickers: Array.from(missingSnapshotSet).slice(0, 20),
    },
  };
}

export async function buildOverviewQuoteOverlays(
  env: Env,
  rows: Array<{ ticker: string; groupTitle: string; barDate: string | null }>,
  expectedAsOfDate: string,
): Promise<OverviewQuoteOverlayResult> {
  const uniqueRows = normalizeOverviewQuoteRows(rows);
  const snapshotResult = await fetchOverviewQuoteSnapshots(env, eligibleOverviewQuoteTickers(uniqueRows), expectedAsOfDate);
  return buildOverviewQuoteOverlaysFromSnapshots(uniqueRows, expectedAsOfDate, snapshotResult);
}
