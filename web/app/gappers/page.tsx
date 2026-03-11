import { GappersDashboard } from "@/components/gappers-dashboard";
import { ManualRefreshButton } from "@/components/manual-refresh-button";

export default function GappersPage() {
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">Gappers</h2>
          <p className="text-sm text-slate-400">
            US premarket gap leaders with ranked catalysts, liquidity context, and structured analysis.
          </p>
        </div>
        <ManualRefreshButton page="gappers" />
      </div>
      <GappersDashboard />
    </div>
  );
}
