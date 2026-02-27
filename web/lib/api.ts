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

export async function adminFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const secret = process.env.NEXT_PUBLIC_ADMIN_SECRET ?? "";
  return getJson<T>(path, {
    ...init,
    headers: {
      Authorization: secret ? `Bearer ${secret}` : "",
      ...(init?.headers ?? {}),
    },
  });
}
