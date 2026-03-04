import { BreadthPanels } from "@/components/breadth-panels";
import { EqualWeightComps } from "@/components/equal-weight-comps";
import { getBreadth, getBreadthSummary, getStatus } from "@/lib/api";
import { StatusBar } from "@/components/status-bar";

export default async function BreadthPage() {
  const [status, breadth, summary] = await Promise.all([getStatus(), getBreadth("sp500-core"), getBreadthSummary()]);
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
