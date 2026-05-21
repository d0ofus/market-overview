import { EarningsDashboard } from "@/components/earnings-dashboard";

export default function EarningsPage() {
  return (
    <div className="space-y-5">
      <div className="card px-5 py-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-3xl">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-accent">Earnings Scanner</div>
            <h2 className="mt-1 text-2xl font-semibold text-slate-100">Earnings Surprises and Gap-Ups</h2>
            <p className="mt-1 text-sm text-slate-400">
              Six-month US earnings surprise log plus release-day gap-up scans with postmarket and regular-open reaction context.
            </p>
          </div>
          <div className="rounded-full border border-borderSoft/70 bg-panelSoft/50 px-3 py-1.5 text-xs font-medium text-slate-300">
            TradingView primary
          </div>
        </div>
      </div>
      <EarningsDashboard />
    </div>
  );
}
