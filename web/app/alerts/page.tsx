import { AlertsDashboard } from "@/components/alerts-dashboard";

export default function AlertsPage() {
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Alerts</h2>
      <p className="text-sm text-slate-400">
        TradingView email-ingested alert log with session/date filters, single or multi-chart mode, and per-ticker daily news.
      </p>
      <AlertsDashboard />
    </div>
  );
}

