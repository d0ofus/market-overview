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

export function getDashboard(date?: string): Promise<SnapshotResponse> {
  return getJson(`/api/dashboard${date ? `?date=${date}` : ""}`);
}

export function getStatus(): Promise<{
  timezone: string;
  autoRefreshLabel: string;
  autoRefreshLocalTime?: string;
  lastUpdated: string | null;
  asOfDate: string | null;
  providerLabel: string;
}> {
  return getJson("/api/status");
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
