import { getProvider, type QuoteSnapshot } from "./provider";
import type { Env, QuoteFreshnessStatus } from "./types";

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

function dailyBarFreshnessReason(ticker: string, barDate: string | null, expectedAsOfDate: string): { status: QuoteFreshnessStatus; reason: string } {
  if (!barDate) {
    return {
      status: "unavailable",
      reason: `No Alpaca snapshot quote or stored daily bar is available for ${ticker}.`,
    };
  }
  if (barDate === expectedAsOfDate) {
    return {
      status: "fresh",
      reason: `No Alpaca snapshot quote is available; stored daily bar is current for ${expectedAsOfDate}.`,
    };
  }
  return {
    status: "stale",
    reason: `No Alpaca snapshot quote is available; last stored daily bar is ${barDate}; expected ${expectedAsOfDate}.`,
  };
}

export function deriveOverviewQuoteOverlayFromSnapshot(input: OverviewQuoteOverlayInput): OverviewQuoteOverlay {
  const ticker = input.ticker.trim().toUpperCase();
  const barDate = input.barDate ?? null;
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
    };
  }

  const snapshot = input.snapshot ?? null;
  if (snapshot) {
    return {
      ticker,
      quotePrice: snapshot.price,
      quotePrevClose: snapshot.prevClose,
      quoteChange1d: snapshot.change1d,
      quoteSource: snapshot.source,
      quoteFetchedAt: snapshot.fetchedAt,
      quoteFreshnessStatus: "fresh",
      quoteFreshnessReason: barDate
        ? `Alpaca snapshot quote is available; last stored daily bar is ${barDate}.`
        : "Alpaca snapshot quote is available; no stored daily bar is available.",
    };
  }

  const fallback = dailyBarFreshnessReason(ticker, barDate, input.expectedAsOfDate);
  return {
    ticker,
    quotePrice: null,
    quotePrevClose: null,
    quoteChange1d: null,
    quoteSource: barDate ? "daily-bars" : null,
    quoteFetchedAt: null,
    quoteFreshnessStatus: fallback.status,
    quoteFreshnessReason: fallback.reason,
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
): Promise<OverviewQuoteSnapshotFetchResult> {
  const uniqueTickers = Array.from(new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean)));
  let providerAttempted = false;
  let providerError: string | null = null;
  let snapshots: Record<string, QuoteSnapshot> = {};
  if (uniqueTickers.length === 0) {
    return { snapshots, providerAttempted, providerError };
  }
  try {
    const provider = getProvider(env);
    providerAttempted = Boolean(provider.getQuoteSnapshot);
    snapshots = provider.getQuoteSnapshot ? await provider.getQuoteSnapshot(uniqueTickers) : {};
  } catch (error) {
    providerError = quoteOverlayErrorMessage(error);
    console.error("overview quote snapshot refresh failed; using stored daily bars", error);
  }
  return { snapshots, providerAttempted, providerError };
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
  const snapshotResult = await fetchOverviewQuoteSnapshots(env, eligibleOverviewQuoteTickers(uniqueRows));
  return buildOverviewQuoteOverlaysFromSnapshots(uniqueRows, expectedAsOfDate, snapshotResult);
}
