import { SectorTracker } from "@/components/sector-tracker";
import { ManualRefreshButton } from "@/components/manual-refresh-button";

export default function SectorPage() {
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Key Sector Tracker</h2>
      <p className="text-sm text-slate-400">
        Track sector momentum, define narratives, and map related tickers across list and calendar views.
      </p>
      <div className="flex justify-end">
        <ManualRefreshButton page="sectors" />
      </div>
      <SectorTracker />
    </div>
  );
}
