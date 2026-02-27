import { BreadthPanels } from "@/components/breadth-panels";
import { getBreadth, getStatus } from "@/lib/api";
import { StatusBar } from "@/components/status-bar";

export default async function BreadthPage() {
  const [status, breadth] = await Promise.all([getStatus(), getBreadth()]);
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
      <BreadthPanels rows={breadth.rows} />
    </div>
  );
}
