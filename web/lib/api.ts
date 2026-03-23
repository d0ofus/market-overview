import type { SnapshotResponse } from "@/types/dashboard";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://127.0.0.1:8787";

export type AlertsSessionFilter = "all" | "premarket" | "regular" | "after-hours";

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
  marketSession: "premarket" | "regular" | "after-hours";
  tradingDay: string;
  source: string;
  createdAt: string;
};

export type AlertNewsRow = {
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
  marketSession: "premarket" | "regular" | "after-hours";
  news: AlertNewsRow[];
};

export type ScanSourceType = "tradingview-public-link" | "csv-text" | "ticker-list";
export type ScanStatus = "ok" | "empty" | "error";

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

export type ScanRuleOperator = "gt" | "gte" | "lt" | "lte" | "eq" | "neq" | "in" | "not_in";

export type ScanRuleScalar = string | number | boolean;

export type ScanRuleFieldReference = {
  type: "field";
  field: string;
  multiplier?: number;
};

export type ScanRule = {
  id: string;
  field: string;
  operator: ScanRuleOperator;
  value: ScanRuleScalar | Array<ScanRuleScalar> | ScanRuleFieldReference;
};

export type ScanPreset = {
  id: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  rules: ScanRule[];
  sortField: string;
  sortDirection: "asc" | "desc";
  rowLimit: number;
  createdAt: string;
  updatedAt: string;
};

export type ScanRow = {
  ticker: string;
  name: string | null;
  sector: string | null;
  industry: string | null;
  change1d: number | null;
  marketCap: number | null;
  relativeVolume: number | null;
  price: number | null;
  avgVolume: number | null;
  priceAvgVolume: number | null;
  rawJson: string | null;
};

export type ScanSnapshot = {
  id: string;
  presetId: string;
  presetName: string;
  providerLabel: string;
  generatedAt: string;
  rowCount: number;
  status: "ok" | "warning" | "error" | "empty";
  error: string | null;
  rows: ScanRow[];
};

export type CompiledScanUniqueTickerRow = {
  ticker: string;
  name: string | null;
  sector: string | null;
  industry: string | null;
  occurrences: number;
  presetIds: string[];
  presetNames: string[];
  latestPrice: number | null;
  latestChange1d: number | null;
  latestMarketCap: number | null;
  latestRelativeVolume: number | null;
};

export type CompiledScansSnapshot = {
  presetIds: string[];
  presetNames: string[];
  generatedAt: string;
  rows: CompiledScanUniqueTickerRow[];
};

export type WatchlistCompilerRunSummary = ScanRunSummary;

export type WatchlistCompilerSetRow = {
  id: string;
  scanDefinitionId: string;
  name: string;
  slug: string;
  isActive: boolean;
  compileDaily: boolean;
  dailyCompileTimeLocal: string | null;
  dailyCompileTimezone: string | null;
  createdAt: string;
  updatedAt: string;
  sourceCount: number;
  latestRun: WatchlistCompilerRunSummary | null;
};

export type WatchlistCompilerSourceRow = {
  id: string;
  setId: string;
  sourceName: string | null;
  sourceUrl: string;
  sourceSections: string | null;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type WatchlistCompilerSetDetail = WatchlistCompilerSetRow & {
  sources: WatchlistCompilerSourceRow[];
};

export type GapperNewsItem = {
  headline: string;
  source: string;
  url: string;
  publishedAt: string | null;
  snippet: string | null;
};

export type GapperAnalysis = {
  summary: string;
  freshnessLabel: "fresh" | "stale" | "unclear";
  freshnessScore: number;
  impactLabel: "high" | "medium" | "low" | "noise";
  impactScore: number;
  liquidityRiskLabel: "normal" | "thin" | "likely-order-driven";
  liquidityRiskScore: number;
  compositeScore: number;
  reasoningBullets: string[];
  model: string;
};

export type GapperRow = {
  ticker: string;
  name: string | null;
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  price: number;
  prevClose: number;
  premarketPrice: number;
  gapPct: number;
  premarketVolume: number;
  news: GapperNewsItem[];
  analysis: GapperAnalysis | null;
  compositeScore: number | null;
};

export type GappersSnapshot = {
  id: string;
  marketSession: string;
  providerLabel: string;
  generatedAt: string;
  rowCount: number;
  status: "ok" | "warning" | "error" | "empty";
  error: string | null;
  warning: string | null;
  rows: GapperRow[];
};

export type LlmProvider = "openai" | "anthropic";

export type GappersLlmConfig = {
  provider: LlmProvider;
  apiKey: string;
  model: string;
  baseUrl?: string | null;
};

export type GappersScanFilters = {
  limit: number;
  minMarketCap?: number | null;
  maxMarketCap?: number | null;
  industries?: string[];
  minPrice?: number | null;
  maxPrice?: number | null;
  minGapPct?: number | null;
  maxGapPct?: number | null;
};

export type PeerGroupType = "fundamental" | "technical" | "custom";
export type PeerMembershipSource = "manual" | "fmp_seed" | "finnhub_seed" | "system";

export type PeerGroupRow = {
  id: string;
  slug: string;
  name: string;
  groupType: PeerGroupType;
  description: string | null;
  priority: number;
  isActive: boolean;
  memberCount?: number;
};

export type PeerDirectoryRow = {
  ticker: string;
  name: string | null;
  exchange: string | null;
  sector: string | null;
  industry: string | null;
  groups: PeerGroupRow[];
};

export type PeerTickerMember = {
  ticker: string;
  name: string | null;
  exchange: string | null;
  sector: string | null;
  industry: string | null;
  source: PeerMembershipSource;
  confidence: number | null;
};

export type PeerTickerDetail = {
  symbol: {
    ticker: string;
    name: string | null;
    exchange: string | null;
    sector: string | null;
    industry: string | null;
    sharesOutstanding: number | null;
  };
  groups: Array<PeerGroupRow & { members: PeerTickerMember[] }>;
};

export type PeerMetricRow = {
  ticker: string;
  price: number | null;
  change1d: number | null;
  marketCap: number | null;
  avgVolume: number | null;
  asOf: string;
  source: string;
};

function sortNewsNewestFirst<T extends { publishedAt: string | null; fetchedAt?: string | null }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const left = Date.parse(a.publishedAt ?? a.fetchedAt ?? "") || 0;
    const right = Date.parse(b.publishedAt ?? b.fetchedAt ?? "") || 0;
    return right - left;
  });
}

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json() as { error?: string };
      if (body?.error) detail = ` - ${body.error}`;
    } catch {
      // no-op
    }
    throw new Error(`API ${path} failed: ${res.status}${detail}`);
  }
  return (await res.json()) as T;
}

function appendQuery(path: string, query: Record<string, string | number | null | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value == null || value === "") continue;
    params.set(key, String(value));
  }
  const encoded = params.toString();
  if (!encoded) return path;
  return `${path}?${encoded}`;
}

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export function getDashboard(date?: string): Promise<SnapshotResponse> {
  return getJson(`/api/dashboard${date ? `?date=${date}` : ""}`);
}

export function getStatus(page?: "overview" | "breadth"): Promise<{
  timezone: string;
  autoRefreshLabel: string;
  autoRefreshLocalTime?: string;
  lastUpdated: string | null;
  asOfDate: string | null;
  providerLabel: string;
}> {
  const query = page ? `?page=${page}` : "";
  return getJson(`/api/status${query}`);
}

export function getBreadth(universeId = "sp500-core") {
  return getJson<{ requestedUniverseId: string; universeId: string; rows: any[] }>(`/api/breadth?universeId=${universeId}&limit=120`);
}

export function getBreadthSummary() {
  return getJson<{ asOfDate: string | null; rows: any[]; unavailable: Array<{ id: string; name: string; reason: string }> }>("/api/breadth/summary");
}

export function getTicker(ticker: string) {
  return getJson<{
    symbol: { ticker: string; name: string; exchange: string };
    series: Array<{ date: string; c: number }>;
    tradingViewEnabled: boolean;
  }>(`/api/ticker/${ticker}`);
}

export function get13fOverview() {
  return getJson<{ managers: any[]; topHoldings: any[] }>("/api/13f/overview");
}

export function get13fManager(id: string) {
  return getJson<{ manager: any; reports: any[]; latestHoldings: any[] }>(`/api/13f/manager/${id}`);
}

export function getSectorTrending(days = 30) {
  return getJson<{ days: number; sectors: any[] }>(`/api/sectors/trending?days=${days}`);
}

export function getSectorEtfs() {
  return getJson<{ rows: any[] }>("/api/etfs/sector");
}

export function getIndustryEtfs() {
  return getJson<{ rows: any[] }>("/api/etfs/industry");
}

export function getEtfConstituents(ticker: string, forceSync = false) {
  return getJson<{ etf: any; rows: any[]; syncStatus: any; warning: string | null }>(`/api/etf/${ticker}/constituents${forceSync ? "?force=1" : ""}`);
}

export function getSectorEntries() {
  return getJson<{ rows: any[] }>("/api/sectors/entries");
}

export function getSectorCalendar(month: string) {
  return getJson<{ month: string; rows: any[] }>(`/api/sectors/calendar?month=${month}`);
}

export function getSectorNarratives() {
  return getJson<{ rows: any[] }>("/api/sectors/narratives");
}

export function getSectorSymbolOptions(sector?: string) {
  return getJson<{ rows: any[] }>(`/api/sectors/symbol-options${sector ? `?sector=${encodeURIComponent(sector)}` : ""}`);
}

export function getAlerts(params: {
  startDate?: string;
  endDate?: string;
  session?: AlertsSessionFilter;
  limit?: number;
}) {
  return getJson<{ filters: { startDate: string; endDate: string; session: AlertsSessionFilter; limit: number }; rows: AlertLogRow[] }>(
    appendQuery("/api/alerts", params),
  );
}

export function getAlertTickerDays(params: {
  startDate?: string;
  endDate?: string;
  session?: AlertsSessionFilter;
  limit?: number;
}) {
  return getJson<{ filters: { startDate: string; endDate: string; session: AlertsSessionFilter; limit: number }; rows: AlertTickerDayRow[] }>(
    appendQuery("/api/alerts/unique-tickers", params),
  );
}

export function getAlertNews(ticker: string, tradingDay: string) {
  return getJson<{ ticker: string; tradingDay: string; rows: AlertNewsRow[] }>(
    appendQuery("/api/alerts/news", { ticker, tradingDay }),
  );
}

export function getTickerNews(ticker: string, tradingDay?: string | null, limit = 5) {
  return getJson<{ ticker: string; tradingDay: string; providersTried?: string[]; rows: AlertNewsRow[] }>(
    appendQuery(`/api/ticker/${encodeURIComponent(ticker)}/news`, {
      tradingDay: tradingDay ?? undefined,
      limit,
    }),
  ).then((payload) => ({
    ...payload,
    rows: sortNewsNewestFirst(payload.rows ?? []),
  }));
}

export function getScansSnapshot(presetId?: string | null) {
  return getJson<ScanSnapshot>(appendQuery("/api/scans", { presetId: presetId ?? undefined }));
}

export function getScanPresets() {
  return getJson<{ rows: ScanPreset[] }>("/api/scans/presets");
}

export function getCompiledScansSnapshot(presetIds: string[]) {
  return getJson<CompiledScansSnapshot>(appendQuery("/api/scans/compiled", {
    presetIds: presetIds.join(","),
  }));
}

export function getCompiledScansExportUrl(presetIds: string[], dateSuffix?: string | null) {
  return apiUrl(appendQuery("/api/scans/compiled/export.txt", {
    presetIds: presetIds.join(","),
    dateSuffix: dateSuffix ?? undefined,
  }));
}

export function refreshScansSnapshot(presetId?: string | null) {
  return adminFetch<{ ok: boolean; snapshot: ScanSnapshot }>("/api/admin/scans/refresh", {
    method: "POST",
    body: JSON.stringify({ presetId: presetId ?? null }),
  });
}

export function createScanPreset(payload: {
  name: string;
  isDefault?: boolean;
  isActive?: boolean;
  rules: ScanRule[];
  sortField?: string;
  sortDirection?: "asc" | "desc";
  rowLimit?: number;
}) {
  return adminFetch<{ ok: boolean; preset: ScanPreset }>("/api/admin/scans/presets", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateScanPreset(id: string, payload: {
  name?: string;
  isDefault?: boolean;
  isActive?: boolean;
  rules?: ScanRule[];
  sortField?: string;
  sortDirection?: "asc" | "desc";
  rowLimit?: number;
}) {
  return adminFetch<{ ok: boolean; preset: ScanPreset }>(`/api/admin/scans/presets/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function deleteScanPreset(id: string) {
  return adminFetch<{ ok: boolean; presetId: string }>(`/api/admin/scans/presets/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function getWatchlistCompilerSets(includeInactive = false) {
  return getJson<{ rows: WatchlistCompilerSetRow[] }>(
    appendQuery("/api/watchlist-compiler/sets", { includeInactive: includeInactive ? 1 : undefined }),
  );
}

export function getWatchlistCompilerSet(id: string) {
  return getJson<WatchlistCompilerSetDetail>(`/api/watchlist-compiler/sets/${encodeURIComponent(id)}`);
}

export function getWatchlistCompilerRuns(id: string, limit = 25) {
  return getJson<{ rows: WatchlistCompilerRunSummary[] }>(
    appendQuery(`/api/watchlist-compiler/sets/${encodeURIComponent(id)}/runs`, { limit }),
  );
}

export function getWatchlistCompilerCompiled(id: string, runId?: string | null) {
  return getJson<{ set: WatchlistCompilerSetDetail; runId: string | null; rows: ScanCompiledRow[] }>(
    appendQuery(`/api/watchlist-compiler/sets/${encodeURIComponent(id)}/compiled`, { runId: runId ?? undefined }),
  );
}

export function getWatchlistCompilerUnique(id: string, runId?: string | null) {
  return getJson<{ set: WatchlistCompilerSetDetail; runId: string | null; rows: ScanUniqueTickerRow[] }>(
    appendQuery(`/api/watchlist-compiler/sets/${encodeURIComponent(id)}/unique`, { runId: runId ?? undefined }),
  );
}

export function getWatchlistCompilerExportUrl(
  id: string,
  format: "csv" | "txt",
  mode: "compiled" | "unique",
  options?: { runId?: string | null; dateSuffix?: string | null },
) {
  return apiUrl(appendQuery(`/api/watchlist-compiler/sets/${encodeURIComponent(id)}/export.${format}`, {
    mode,
    runId: options?.runId ?? undefined,
    dateSuffix: options?.dateSuffix ?? undefined,
  }));
}

export function getAdminWatchlistCompilerSets() {
  return adminFetch<{ rows: WatchlistCompilerSetRow[] }>("/api/admin/watchlist-compiler/sets");
}

export function createAdminWatchlistCompilerSet(payload: {
  name: string;
  slug?: string | null;
  isActive?: boolean;
  compileDaily?: boolean;
  dailyCompileTimeLocal?: string | null;
  dailyCompileTimezone?: string | null;
}) {
  return adminFetch<{ ok: boolean; id: string }>("/api/admin/watchlist-compiler/sets", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateAdminWatchlistCompilerSet(id: string, payload: {
  name?: string;
  slug?: string | null;
  isActive?: boolean;
  compileDaily?: boolean;
  dailyCompileTimeLocal?: string | null;
  dailyCompileTimezone?: string | null;
}) {
  return adminFetch<{ ok: boolean; id: string }>(`/api/admin/watchlist-compiler/sets/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function deleteAdminWatchlistCompilerSet(id: string) {
  return adminFetch<{ ok: boolean; id: string }>(`/api/admin/watchlist-compiler/sets/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function createAdminWatchlistCompilerSource(setId: string, payload: { sourceName?: string | null; sourceUrl: string; sourceSections?: string | null; isActive?: boolean }) {
  return adminFetch<{ ok: boolean; id: string }>(`/api/admin/watchlist-compiler/sets/${encodeURIComponent(setId)}/sources`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateAdminWatchlistCompilerSource(id: string, payload: { sourceName?: string | null; sourceUrl?: string; sourceSections?: string | null; sortOrder?: number; isActive?: boolean }) {
  return adminFetch<{ ok: boolean; id: string }>(`/api/admin/watchlist-compiler/sources/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function deleteAdminWatchlistCompilerSource(id: string) {
  return adminFetch<{ ok: boolean; id: string }>(`/api/admin/watchlist-compiler/sources/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function compileAdminWatchlistCompilerSet(id: string) {
  return adminFetch<{ ok: boolean; run: WatchlistCompilerRunSummary; set: WatchlistCompilerSetDetail }>(
    `/api/admin/watchlist-compiler/sets/${encodeURIComponent(id)}/compile`,
    { method: "POST" },
  );
}

export function getGappers(limit = 50, force = false, filters?: GappersScanFilters | null) {
  return getJson<GappersSnapshot>(appendQuery("/api/gappers", {
    limit,
    force: force ? 1 : undefined,
    minMarketCap: filters?.minMarketCap,
    maxMarketCap: filters?.maxMarketCap,
    industries: filters?.industries?.join(","),
    minPrice: filters?.minPrice,
    maxPrice: filters?.maxPrice,
    minGapPct: filters?.minGapPct,
    maxGapPct: filters?.maxGapPct,
  }));
}

export function getGappersWithConfig(
  limit = 50,
  force = false,
  llmConfig?: GappersLlmConfig | null,
  filters?: GappersScanFilters | null,
) {
  const headers: Record<string, string> = {};
  if (llmConfig?.provider) headers["x-llm-provider"] = llmConfig.provider;
  if (llmConfig?.apiKey) headers["x-llm-api-key"] = llmConfig.apiKey;
  if (llmConfig?.model) headers["x-llm-model"] = llmConfig.model;
  if (llmConfig?.baseUrl) headers["x-llm-base-url"] = llmConfig.baseUrl;
  return getJson<GappersSnapshot>(appendQuery("/api/gappers", {
    limit,
    force: force ? 1 : undefined,
    minMarketCap: filters?.minMarketCap,
    maxMarketCap: filters?.maxMarketCap,
    industries: filters?.industries?.join(","),
    minPrice: filters?.minPrice,
    maxPrice: filters?.maxPrice,
    minGapPct: filters?.minGapPct,
    maxGapPct: filters?.maxGapPct,
  }), { headers });
}

export function getPeerGroups(includeInactive = false) {
  return getJson<{ rows: PeerGroupRow[] }>(appendQuery("/api/peer-groups/groups", { includeInactive: includeInactive ? 1 : undefined }));
}

export function getPeerDirectory(params: {
  q?: string;
  groupId?: string;
  groupType?: PeerGroupType | "";
  active?: "1" | "0" | "";
  limit?: number;
  offset?: number;
}) {
  return getJson<{ rows: PeerDirectoryRow[]; total: number; limit: number; offset: number }>(
    appendQuery("/api/peer-groups/directory", params),
  );
}

export function getPeerTickerDetail(ticker: string) {
  return getJson<PeerTickerDetail>(`/api/peer-groups/ticker/${encodeURIComponent(ticker)}`);
}

export function getPeerTickerMetrics(ticker: string) {
  return getJson<{ ticker: string; rows: PeerMetricRow[]; error: string | null }>(
    `/api/peer-groups/ticker/${encodeURIComponent(ticker)}/metrics`,
  );
}

export function getAdminPeerGroups() {
  return adminFetch<{ rows: PeerGroupRow[] }>("/api/admin/peer-groups");
}

export function createAdminPeerGroup(payload: {
  name: string;
  slug?: string | null;
  groupType?: PeerGroupType;
  description?: string | null;
  priority?: number;
  isActive?: boolean;
}) {
  return adminFetch<{ ok: boolean; id: string }>("/api/admin/peer-groups", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateAdminPeerGroup(id: string, payload: {
  name?: string;
  slug?: string | null;
  groupType?: PeerGroupType;
  description?: string | null;
  priority?: number | null;
  isActive?: boolean;
}) {
  return adminFetch<{ ok: boolean; id: string }>(`/api/admin/peer-groups/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function deleteAdminPeerGroup(id: string) {
  return adminFetch<{ ok: boolean; id: string }>(`/api/admin/peer-groups/${id}`, {
    method: "DELETE",
  });
}

export function searchAdminPeerTickers(q: string) {
  return adminFetch<{ rows: Array<{ ticker: string; name: string | null; exchange: string | null; sector: string | null; industry: string | null }> }>(
    appendQuery("/api/admin/peer-groups/ticker-search", { q }),
  );
}

export function getAdminPeerTickerDetail(ticker: string) {
  return adminFetch<PeerTickerDetail>(`/api/admin/peer-groups/ticker/${encodeURIComponent(ticker)}`);
}

export function addAdminPeerGroupMember(groupId: string, payload: {
  ticker: string;
  source?: PeerMembershipSource;
  confidence?: number | null;
}) {
  return adminFetch<{ ok: boolean; ticker: string }>(`/api/admin/peer-groups/${groupId}/members`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function removeAdminPeerGroupMember(groupId: string, ticker: string) {
  return adminFetch<{ ok: boolean; ticker: string }>(`/api/admin/peer-groups/${groupId}/members/${encodeURIComponent(ticker)}`, {
    method: "DELETE",
  });
}

export function seedAdminPeerGroup(ticker: string) {
  return adminFetch<{ ok: boolean; groupId: string; ticker: string; insertedTickers: string[]; sourceBreakdown: Record<string, number> }>(
    "/api/admin/peer-groups/seed",
    {
      method: "POST",
      body: JSON.stringify({ ticker }),
    },
  );
}

export function bootstrapAdminPeerGroups(payload?: {
  limit?: number;
  offset?: number;
  q?: string;
  onlyUnseeded?: boolean;
  providerMode?: "both" | "finnhub" | "fmp";
  enrichPeers?: boolean;
}) {
  return adminFetch<{
    ok: boolean;
    requested: number;
    attempted: number;
    rows: Array<{
      ticker: string;
      ok: boolean;
      groupId?: string;
      insertedTickers?: string[];
      sourceBreakdown?: Record<string, number>;
      error?: string;
    }>;
  }>("/api/admin/peer-groups/bootstrap", {
    method: "POST",
    body: JSON.stringify(payload ?? {}),
  });
}

export async function adminFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const secret = process.env.NEXT_PUBLIC_ADMIN_SECRET ?? "";
  const headers: Record<string, string> = {};
  if (secret) headers.Authorization = `Bearer ${secret}`;
  return getJson<T>(path, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
  });
}

export function refreshPageData(page: string, ticker?: string | null) {
  return adminFetch<{ ok: boolean; page: string; refreshedTickers: number; notes?: string }>("/api/admin/refresh-page", {
    method: "POST",
    body: JSON.stringify({ page, ticker: ticker ?? null }),
  }).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error ?? "");
    if (!message.includes("API /api/admin/refresh-page failed: 404")) throw error;

    // Backward-compatible fallback for older worker deployments.
    if (page === "breadth") {
      await adminFetch<{ ok: boolean; asOfDate: string; universeCount: number }>("/api/admin/run-breadth", { method: "POST" });
      return { ok: true, page, refreshedTickers: 0, notes: "Fallback breadth refresh completed (legacy API)." };
    }
    if (page === "alerts") {
      return { ok: true, page, refreshedTickers: 0, notes: "Legacy API host does not support alerts refresh endpoint." };
    }
    if (page === "scans") {
      return { ok: true, page, refreshedTickers: 0, notes: "Legacy API host does not support scans refresh endpoint." };
    }
    if (page === "watchlist-compiler") {
      return { ok: true, page, refreshedTickers: 0, notes: "Legacy API host does not support watchlist compiler refresh endpoint." };
    }
    if (page === "gappers") {
      return { ok: true, page, refreshedTickers: 0, notes: "Legacy API host does not support gappers refresh endpoint." };
    }

    await adminFetch<{ ok: boolean; snapshotId: string; asOfDate: string }>("/api/admin/run-eod", { method: "POST" });
    return { ok: true, page, refreshedTickers: 0, notes: "Fallback refresh completed (legacy API)." };
  });
}

export function updateSectorEntry(
  id: string,
  payload: { sectorName: string; eventDate: string; trendScore?: number; notes?: string | null; narrativeId?: string | null; symbols?: string[] },
) {
  return adminFetch<{ ok: boolean; id: string }>(`/api/sectors/entries/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function deleteSectorEntry(id: string) {
  return adminFetch<{ ok: boolean; id: string }>(`/api/sectors/entries/${id}`, {
    method: "DELETE",
  });
}
