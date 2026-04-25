import { ScansPageDashboard } from "@/components/scans-page-dashboard";

export default function ScansPage() {
  return (
    <div className="space-y-5">
      <div className="card px-5 py-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-3xl">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-accent">Scanner Workspace</div>
            <h2 className="mt-1 text-2xl font-semibold text-slate-100">Scans</h2>
            <p className="mt-1 text-sm text-slate-400">
              Save customizable market scans, refresh the latest snapshot on demand, and open peer context or news and chart detail from each result.
            </p>
          </div>
          <div className="rounded-full border border-borderSoft/70 bg-panelSoft/50 px-3 py-1.5 text-xs font-medium text-slate-300">
            Presets + snapshots
          </div>
        </div>
      </div>
      <ScansPageDashboard />
    </div>
  );
}
