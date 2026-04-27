import { PatternScannerDashboard } from "@/components/pattern-scanner-dashboard";

export default function PatternScannerPage() {
  return (
    <div className="space-y-5">
      <div className="card px-5 py-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-3xl">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-accent">Pattern Learning</div>
            <h2 className="mt-1 text-2xl font-semibold text-slate-100">Pattern Scanner</h2>
            <p className="mt-1 text-sm text-slate-400">
              Train preferred setup examples, review scored candidates, and inspect the model behind each daily scan.
            </p>
          </div>
          <div className="rounded-full border border-borderSoft/70 bg-panelSoft/50 px-3 py-1.5 text-xs font-medium text-slate-300">
            Similarity V1
          </div>
        </div>
      </div>
      <PatternScannerDashboard />
    </div>
  );
}
