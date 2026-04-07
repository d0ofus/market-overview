import { CorrelationDashboard } from "@/components/correlation-dashboard";

export default function CorrelationPage() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">Correlation</h2>
        <p className="text-sm text-slate-400">
          Screen multiple tickers with a correlation matrix, then drill into one pair with regression, spread, z-score, rolling correlation,
          and lead-lag analysis.
        </p>
      </div>
      <CorrelationDashboard />
    </div>
  );
}
