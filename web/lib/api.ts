import type { SnapshotResponse } from "@/types/dashboard";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://127.0.0.1:8787";

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`API ${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

export function getDashboard(date?: string): Promise<SnapshotResponse> {
  return getJson(`/api/dashboard${date ? `?date=${date}` : ""}`);
}

export function getStatus(): Promise<{
  timezone: string;
  autoRefreshLabel: string;
  lastUpdated: string | null;
  asOfDate: string | null;
  providerLabel: string;
}> {
  return getJson("/api/status");
}

export function getBreadth(universeId = "sp500-lite") {
  return getJson<{ universeId: string; rows: any[] }>(`/api/breadth?universeId=${universeId}&limit=120`);
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

export async function adminFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const secret = process.env.NEXT_PUBLIC_ADMIN_SECRET ?? "";
  const headers: Record<string, string> = {};
  if (secret) headers.Authorization = `Bearer ${secret}`;
  return getJson<T>(path, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
  });
}
