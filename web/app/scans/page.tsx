import { ScansPageDashboard } from "@/components/scans-page-dashboard";

export default function ScansPage() {
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">Scans</h2>
          <p className="text-sm text-slate-400">
            Save customizable market scans, refresh the latest snapshot on demand, and open peer context or news and chart detail from each result.
          </p>
        </div>
      </div>
      <ScansPageDashboard />
    </div>
  );
}
