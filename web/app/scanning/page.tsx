import { ScanningDashboard } from "@/components/scanning-dashboard";
import { ManualRefreshButton } from "@/components/manual-refresh-button";

export default function ScanningPage() {
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">Scanning</h2>
          <p className="text-sm text-slate-400">
            Save scan definitions, ingest TradingView or fallback sources on demand, then review compiled rows or unique tickers.
          </p>
        </div>
        <ManualRefreshButton page="scanning" />
      </div>
      <ScanningDashboard />
    </div>
  );
}
