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

function summaryFallbackFromHistory(rows: BreadthRow[], asOfDate: string | null) {
  const latest = rows[rows.length - 1];
  if (!latest) {
    return {
      asOfDate,
      rows: [],
      unavailable: [{ id: "breadth-summary-api", name: "Breadth Summary API", reason: "Using legacy breadth payload fallback." }],
    };
  }
  return {
    asOfDate: latest.asOfDate ?? asOfDate,
    rows: [
      {
        ...latest,
        universeName: latest.universeId === "sp500-lite" ? "S&P 500 Lite Universe" : latest.universeId,
      },
    ],
    unavailable: [{ id: "breadth-summary-api", name: "Breadth Summary API", reason: "Using legacy breadth payload fallback." }],
  };
}

export default async function BreadthPage() {
  const [status, breadth] = await Promise.all([getStatus(), getBreadth("sp500-core")]);
  const summary = await getBreadthSummary().catch(() => summaryFallbackFromHistory((breadth.rows ?? []) as BreadthRow[], status.asOfDate));
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
      <BreadthPanels rows={breadth.rows} summary={summary} />
      <EqualWeightComps />
    </div>
  );
}
