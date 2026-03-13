import { ManualRefreshButton } from "@/components/manual-refresh-button";
import { WatchlistCompilerDashboard } from "@/components/watchlist-compiler-dashboard";

export default function WatchlistCompilerPage() {
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">Watchlist Compiler</h2>
          <p className="text-sm text-slate-400">
            Compile multiple public TradingView watchlists into one saved run, review compiled or unique tickers, and export TradingView-ready files.
          </p>
        </div>
        <ManualRefreshButton page="watchlist-compiler" />
      </div>
      <WatchlistCompilerDashboard />
    </div>
  );
}
