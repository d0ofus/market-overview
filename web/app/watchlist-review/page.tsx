import { WatchlistReviewDashboard } from "@/components/watchlist-review-dashboard";

export default function WatchlistReviewPage() {
  return (
    <div className="space-y-5">
      <div className="card px-5 py-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-3xl">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-accent">AI Watchlist Approval</div>
            <h2 className="mt-1 text-2xl font-semibold text-slate-100">Watchlist Review</h2>
            <p className="mt-1 text-sm text-slate-400">
              Review Hermes-generated TradingView watchlist movement candidates, approve overrides, and export changes for the MCP apply step.
            </p>
          </div>
          <div className="rounded-full border border-borderSoft/70 bg-panelSoft/50 px-3 py-1.5 text-xs font-medium text-slate-300">
            Export-only apply layer
          </div>
        </div>
      </div>
      <WatchlistReviewDashboard />
    </div>
  );
}
