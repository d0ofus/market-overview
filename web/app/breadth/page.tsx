import { BreadthPanels } from "@/components/breadth-panels";
import { EqualWeightComps } from "@/components/equal-weight-comps";
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

const universeOrder = ["sp500-core", "sp500-lite", "nasdaq-core", "nyse-core", "russell2000-core", "overall-market-proxy"];

const universeNames: Record<string, string> = {
  "sp500-core": "S&P 500",
  "sp500-lite": "S&P 500 Index (Proxy)",
  "nasdaq-core": "NASDAQ (QQQ Proxy)",
  "nyse-core": "NYSE (Proxy)",
  "russell2000-core": "Russell 2000",
  "overall-market-proxy": "Overall Market (Proxy)",
};

const coreUniverseSource: Record<string, string> = {
  "sp500-lite": "S&P 500 proxy set from local seeded universe + daily bars.",
  "sp500-core": "SPY ETF holdings proxy (free holdings pages) + daily bars.",
  "nasdaq-core": "QQQ ETF holdings proxy (NASDAQ-100 subset) + daily bars.",
  "nyse-core": "Exchange-tagged NYSE equities from local symbols + daily bars (proxy).",
  "russell2000-core": "IWM ETF holdings proxy + daily bars.",
  "overall-market-proxy": "Union of SPY/QQQ/IWM proxy universes + daily bars.",
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
  if (!present.has("sp500-core") && !present.has("sp500-lite")) {
    unavailable.push({ id: "sp500", name: "S&P 500", reason: "No breadth snapshots currently available from API host." });
  }
  if (!present.has("nasdaq-core")) {
    unavailable.push({ id: "nasdaq-core", name: "NASDAQ", reason: "NASDAQ proxy breadth not available from API host." });
  }
  if (!present.has("nyse-core")) {
    unavailable.push({ id: "nyse-core", name: "NYSE", reason: "NYSE constituent feed is not fully available in free sources." });
  }
  if (!present.has("russell2000-core")) {
    unavailable.push({ id: "russell2000-core", name: "Russell 2000", reason: "Russell 2000 proxy breadth not available from API host." });
  }

  const dated = summaryRows.find((r) => r.asOfDate)?.asOfDate ?? asOfDate;
  return { asOfDate: dated, rows: summaryRows, unavailable };
}

export default async function BreadthPage() {
  const statusPromise = getStatus();
  const sp500PrimaryPromise = loadUniverse("sp500-core");
  const summaryPromise = getBreadthSummary().catch(() => null);

  const [status, sp500PrimaryRows, summaryApi] = await Promise.all([statusPromise, sp500PrimaryPromise, summaryPromise]);

  let historyRows = sp500PrimaryRows;
  if (historyRows.length === 0) {
    historyRows = await loadUniverse("sp500-lite");
  }

  const summary = summaryApi
    ? {
        ...summaryApi,
        rows: (summaryApi.rows ?? []).map((row: any) => ({
          ...row,
          universeName: universeNames[row.universeId] ?? row.universeName ?? row.universeId,
          dataSource: row.dataSource ?? coreUniverseSource[row.universeId] ?? null,
        })),
      }
    : buildSummaryFromUniverseRows(
        {
          "sp500-core": sp500PrimaryRows,
          "sp500-lite": historyRows,
          "nasdaq-core": await loadUniverse("nasdaq-core"),
          "nyse-core": await loadUniverse("nyse-core"),
          "russell2000-core": await loadUniverse("russell2000-core"),
          "overall-market-proxy": await loadUniverse("overall-market-proxy"),
        },
        status.asOfDate,
      );

  return (
    <div className="space-y-4">
      <StatusBar
        asOfDate={status.asOfDate}
        lastUpdated={status.lastUpdated}
        timezone={status.timezone}
        autoRefreshLabel={status.autoRefreshLabel}
        providerLabel={status.providerLabel}
      />
      <h2 className="text-xl font-semibold">03 Market Breadth & Sentiment</h2>
      <BreadthPanels rows={historyRows} summary={summary} />
      <EqualWeightComps />
    </div>
  );
}
