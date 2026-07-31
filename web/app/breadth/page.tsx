import { BreadthPanels } from "@/components/breadth-panels";
import { EqualWeightComps } from "@/components/equal-weight-comps";
import { ManualRefreshButton } from "@/components/manual-refresh-button";
import { getBreadth, getBreadthSummary, getStatus } from "@/lib/api";
import { StatusBar } from "@/components/status-bar";

type BreadthRow = {
  asOfDate: string;
  universeId: string;
  advancers: number;
  decliners: number;
  unchanged: number;
  pctAbove20MA: number;
  pctAbove50MA: number;
  pctAbove200MA: number;
  new20DHighs: number;
  new20DLows: number;
  medianReturn1D: number;
  medianReturn5D: number;
  metrics?: Record<string, unknown> | null;
  dataSource?: string | null;
  provenance?: {
    source?: string | null;
    sourceType?: string | null;
    sourceUrl?: string | null;
    sourceAsOfDate?: string | null;
    sourceMemberCount?: number | null;
    resolvedMemberCount?: number | null;
    unresolvedCount?: number | null;
    unresolvedTickers?: string[];
  } | null;
};

type SummaryRow = BreadthRow & {
  universeName: string;
};

type SummaryPayload = {
  asOfDate: string | null;
  rows: SummaryRow[];
  unavailable: Array<{ id: string; name: string; reason: string }>;
};

type StatusPayload = {
  timezone: string;
  autoRefreshLabel: string;
  autoRefreshLocalTime?: string;
  lastUpdated: string | null;
  asOfDate: string | null;
  providerLabel: string;
};

const universeOrder = ["sp500-core", "nasdaq-core", "nyse-core", "russell2000-core", "overall-market-proxy"];

const universeNames: Record<string, string> = {
  "sp500-core": "S&P 500",
  "nasdaq-core": "NASDAQ",
  "nyse-core": "NYSE",
  "russell2000-core": "Russell 2000 — IWM proxy",
  "overall-market-proxy": "Overall Market",
};

const coreUniverseSource: Record<string, string> = {
  "sp500-core": "S&P 500 constituents CSV (datasets/s-and-p-500-companies) + provider daily bars.",
  "nasdaq-core": "NasdaqTrader nasdaqtraded.txt filtered common-stock NASDAQ listings + provider daily bars.",
  "nyse-core": "NasdaqTrader nasdaqtraded.txt filtered common-stock NYSE listings + provider daily bars.",
  "russell2000-core": "iShares IWM official ETF holdings proxy (not licensed FTSE Russell index constituents) + provider daily bars.",
  "overall-market-proxy": "NasdaqTrader filtered US common-stock universe + provider daily bars.",
};


async function loadUniverse(universeId: string): Promise<BreadthRow[]> {
  try {
    const payload = await getBreadth(universeId);
    return (payload.rows ?? []) as BreadthRow[];
  } catch {
    return [];
  }
}


export default async function BreadthPage() {
  const summaryPromise = getBreadthSummary().catch(() => null);
  const universeRowsPromise = Promise.all(universeOrder.map(async (universeId) => [universeId, await loadUniverse(universeId)] as const));

  const [summaryApi, universeRowsPairs] = await Promise.all([summaryPromise, universeRowsPromise]);
  const status = await getStatus("breadth").catch(
    (): StatusPayload => ({
      timezone: "Australia/Melbourne",
      autoRefreshLabel: "08:15 Australia/Melbourne (prev US close)",
      autoRefreshLocalTime: "08:15",
      lastUpdated: null,
      asOfDate: null,
      providerLabel: "Alpaca (IEX Delayed Daily Bars)",
    }),
  );

  const historyByUniverse = Object.fromEntries(universeRowsPairs) as Record<string, BreadthRow[]>;
  const historyRows = historyByUniverse["sp500-core"] ?? [];

  const summary: SummaryPayload = summaryApi
    ? {
        ...summaryApi,
        rows: (Array.isArray(summaryApi.rows) ? summaryApi.rows : []).filter(Boolean).map((row: any) => ({
          ...row,
          universeName: universeNames[row.universeId] ?? row.universeName ?? row.universeId,
          dataSource: row.dataSource ?? coreUniverseSource[row.universeId] ?? null,
        })),
        unavailable: Array.isArray(summaryApi.unavailable) ? summaryApi.unavailable : [],
      }
    : {
        asOfDate: null,
        rows: [],
        unavailable: universeOrder.map((id) => ({
          id,
          name: universeNames[id] ?? id,
          reason: "Current breadth summary is unavailable because freshness or provenance validation failed.",
        })),
      };
  const statusAsOfDate = status.asOfDate ?? summary.asOfDate ?? null;
  const statusLastUpdated = status.lastUpdated ?? (summary.asOfDate ? `${summary.asOfDate}T00:00:00Z` : null);

  return (
    <div className="space-y-4">
      <StatusBar
        asOfDate={statusAsOfDate}
        lastUpdated={statusLastUpdated}
        timezone={status.timezone}
        autoRefreshLabel={status.autoRefreshLabel}
        providerLabel={status.providerLabel}
      />
      <div className="flex justify-end">
        <ManualRefreshButton page="breadth" />
      </div>
      <BreadthPanels rows={historyRows} summary={summary} histories={historyByUniverse} footer={<EqualWeightComps />} />
    </div>
  );
}
