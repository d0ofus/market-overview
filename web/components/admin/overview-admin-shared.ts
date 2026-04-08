import type { SnapshotResponse } from "@/types/dashboard";

export const rankingOptions = ["1D", "5D", "1W", "YTD", "52W"] as const;
export const allColumns = [
  "ticker",
  "name",
  "price",
  "1D",
  "1W",
  "3M",
  "6M",
  "5D",
  "YTD",
  "pctFrom52WHigh",
  "sparkline",
  "relativeStrength30dVsSpy",
];

export const refreshTimezoneOptions = [
  { label: "Melbourne", value: "Australia/Melbourne" },
  { label: "Sydney", value: "Australia/Sydney" },
  { label: "Singapore", value: "Asia/Singapore" },
  { label: "New York", value: "America/New_York" },
] as const;

export const DEFAULT_REFRESH_TIME = "08:15";
export const DEFAULT_REFRESH_TIMEZONE = "Australia/Melbourne";

export type OverviewAdminConfig = SnapshotResponse["config"];
export type OverviewAdminSection = OverviewAdminConfig["sections"][number];
export type OverviewAdminGroup = OverviewAdminSection["groups"][number];
export type OverviewAdminItem = OverviewAdminGroup["items"][number];

export type EtfListRow = {
  ticker: string;
  fundName?: string | null;
  parentSector?: string | null;
  industry?: string | null;
  sourceUrl?: string | null;
};

export type EtfSyncStatusRow = {
  etfTicker: string;
  status: string | null;
  source: string | null;
  lastSyncedAt: string | null;
  updatedAt: string | null;
  recordsCount: number;
  error: string | null;
};

export type EtfDiagnosticsResult = {
  backendRevision: string;
  serverTimeUtc: string;
  dataProvider: string;
  ticker: string;
  db: { ok: boolean; error: string | null };
  watchlists: Array<{ listType: string; parentSector: string | null; industry: string | null; fundName: string | null; sourceUrl?: string | null }>;
  sourceUrl?: string | null;
  syncStatus: { status: string | null; source: string | null; lastSyncedAt: string | null; updatedAt: string | null; recordsCount: number; error: string | null } | null;
  constituentSummary: { count: number; latestAsOfDate: string | null; latestUpdatedAt: string | null };
  topConstituents: Array<{ ticker: string; name: string | null; weight: number | null }>;
};

export function isOverviewAdminSection(title: string): boolean {
  return title.includes("Macro Overview") || title.includes("Equities Overview") || title.includes("Market Breadth & Sentiment");
}

export function isIndustryThematicGroup(title: string): boolean {
  return title === "Industry/Thematic ETFs" || title === "Thematic ETFs";
}

export function buildRefreshLabel(localTime: string, timezone: string) {
  return `${localTime} ${timezone} (prev US close)`;
}

export function formatDateTimeCompact(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}
