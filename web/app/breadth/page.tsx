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
};

type SummaryRow = BreadthRow & {
  universeName: string;
};

type SummaryPayload = {
  asOfDate: string | null;
  rows: SummaryRow[];
  unavailable: Array<{ id: string; name: string; reason: string }>;
};

const universeOrder = ["sp500-core", "nasdaq-core", "nyse-core", "russell2000-core", "overall-market-proxy"];

const universeNames: Record<string, string> = {
  "sp500-core": "S&P 500",
  "nasdaq-core": "NASDAQ",
  "nyse-core": "NYSE",
  "russell2000-core": "Russell 2000",
  "overall-market-proxy": "Overall Market",
};

const coreUniverseSource: Record<string, string> = {
  "sp500-core": "S&P 500 constituents CSV (datasets/s-and-p-500-companies) + provider daily bars.",
  "nasdaq-core": "NasdaqTrader nasdaqtraded.txt filtered common-stock NASDAQ listings + provider daily bars.",
  "nyse-core": "NasdaqTrader nasdaqtraded.txt filtered common-stock NYSE listings + provider daily bars.",
  "russell2000-core": "Russell 2000 constituent list (LSEG table) filtered to NasdaqTrader common stocks + provider daily bars.",
  "overall-market-proxy": "NasdaqTrader filtered US common-stock universe + provider daily bars.",
};

function pickLatest(rows: BreadthRow[]): BreadthRow | null {
  return rows.length > 0 ? rows[rows.length - 1] : null;
}

async function loadUniverse(universeId: string): Promise<BreadthRow[]> {
  try {
    const payload = await getBreadth(universeId);
    return (payload.rows ?? []) as BreadthRow[];
  } catch {
    return [];
  }
}

function buildSummaryFromUniverseRows(allRows: Record<string, BreadthRow[]>, asOfDate: string | null): SummaryPayload {
  const summaryRows: SummaryRow[] = [];
  for (const universeId of universeOrder) {
    const latest = pickLatest(allRows[universeId] ?? []);
    if (!latest) continue;
    summaryRows.push({
      ...latest,
      universeName: universeNames[latest.universeId] ?? latest.universeId,
      dataSource: latest.dataSource ?? coreUniverseSource[latest.universeId] ?? null,
    });
  }

  const present = new Set(summaryRows.map((r) => r.universeId));
  const unavailable: Array<{ id: string; name: string; reason: string }> = [];
  if (!present.has("sp500-core")) {
    unavailable.push({ id: "sp500", name: "S&P 500", reason: "No breadth snapshots currently available from API host." });
  }
  if (!present.has("nasdaq-core")) {
    unavailable.push({ id: "nasdaq-core", name: "NASDAQ", reason: "NASDAQ breadth snapshots are not available from the API host." });
  }
  if (!present.has("nyse-core")) {
    unavailable.push({ id: "nyse-core", name: "NYSE", reason: "NYSE breadth snapshots are not available from the API host." });
  }
  if (!present.has("russell2000-core")) {
    unavailable.push({ id: "russell2000-core", name: "Russell 2000", reason: "Russell 2000 breadth snapshots are not available from API host." });
  }

  const dated = summaryRows.find((r) => r.asOfDate)?.asOfDate ?? asOfDate;
  return { asOfDate: dated, rows: summaryRows, unavailable };
}

export default async function BreadthPage() {
  const statusPromise = getStatus();
  const summaryPromise = getBreadthSummary().catch(() => null);
  const universeRowsPromise = Promise.all(universeOrder.map(async (universeId) => [universeId, await loadUniverse(universeId)] as const));

  const [status, summaryApi, universeRowsPairs] = await Promise.all([statusPromise, summaryPromise, universeRowsPromise]);

  const historyByUniverse = Object.fromEntries(universeRowsPairs) as Record<string, BreadthRow[]>;
  const historyRows = historyByUniverse["sp500-core"] ?? [];

  const summary = summaryApi
    ? {
        ...summaryApi,
        rows: (summaryApi.rows ?? []).map((row: any) => ({
          ...row,
          universeName: universeNames[row.universeId] ?? row.universeName ?? row.universeId,
          dataSource: row.dataSource ?? coreUniverseSource[row.universeId] ?? null,
        })),
      }
    : buildSummaryFromUniverseRows(historyByUniverse, status.asOfDate);

  return (
    <div className="space-y-4">
      <StatusBar
        asOfDate={status.asOfDate}
        lastUpdated={status.lastUpdated}
        timezone={status.timezone}
        autoRefreshLabel={status.autoRefreshLabel}
        providerLabel={status.providerLabel}
      />
      <div className="flex justify-end">
        <ManualRefreshButton page="breadth" />
      </div>
      <h2 className="text-xl font-semibold">03 Market Breadth & Sentiment</h2>
      <BreadthPanels rows={historyRows} summary={summary} histories={historyByUniverse} footer={<EqualWeightComps />} />
    </div>
  );
}
