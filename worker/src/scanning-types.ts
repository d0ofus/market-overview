export type ScanSourceType = "tradingview-public-link" | "csv-text" | "ticker-list";
export type ScanStatus = "ok" | "empty" | "error";

export type ScanDefinitionInput = {
  name: string;
  providerKey: string;
  sourceType: ScanSourceType;
  sourceValue: string;
  fallbackSourceType?: ScanSourceType | null;
  fallbackSourceValue?: string | null;
  isActive?: boolean;
  notes?: string | null;
};

export type ScanDefinitionRow = {
  id: string;
  name: string;
  providerKey: string;
  sourceType: ScanSourceType;
  sourceValue: string;
  fallbackSourceType: ScanSourceType | null;
  fallbackSourceValue: string | null;
  isActive: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  latestRun: ScanRunSummary | null;
};

export type ScanRunSummary = {
  id: string;
  scanId: string;
  providerKey: string;
  status: ScanStatus;
  sourceType: ScanSourceType;
  sourceValue: string;
  fallbackUsed: boolean;
  rawResultCount: number;
  compiledRowCount: number;
  uniqueTickerCount: number;
  error: string | null;
  providerTraceJson: string | null;
  ingestedAt: string;
};

export type ScanCompiledRow = {
  id: string;
  runId: string;
  scanId: string;
  ticker: string;
  displayName: string | null;
  exchange: string | null;
  providerRowKey: string | null;
  rankValue: number | null;
  rankLabel: string | null;
  price: number | null;
  change1d: number | null;
  volume: number | null;
  marketCap: number | null;
  rawJson: string | null;
  canonicalKey: string;
  createdAt: string;
};

export type ScanUniqueTickerRow = {
  ticker: string;
  displayName: string | null;
  occurrences: number;
  latestRankValue: number | null;
  latestRankLabel: string | null;
  latestPrice: number | null;
  latestChange1d: number | null;
};

export type ScanCandidate = {
  ticker: string;
  displayName?: string | null;
  exchange?: string | null;
  providerRowKey?: string | null;
  rankValue?: number | null;
  rankLabel?: string | null;
  price?: number | null;
  change1d?: number | null;
  volume?: number | null;
  marketCap?: number | null;
  raw: unknown;
};

export type ScanFetchInput = {
  providerKey: string;
  sourceType: ScanSourceType;
  sourceValue: string;
};

export type ScanProviderTrace = {
  provider: string;
  status: "ok" | "empty" | "error" | "skipped";
  rawCount: number;
  acceptedCount: number;
  durationMs: number;
  error?: string;
};

export interface ScanProvider {
  readonly name: string;
  readonly priority: number;
  canHandle(input: ScanFetchInput): boolean;
  fetch(input: ScanFetchInput): Promise<ScanCandidate[]>;
}
