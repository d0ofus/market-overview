type Props = {
  asOfDate: string | null;
  lastUpdated: string | null;
  timezone: string;
  autoRefreshLabel: string;
  providerLabel: string;
};

export function StatusBar({ asOfDate, lastUpdated, timezone, autoRefreshLabel, providerLabel }: Props) {
  return (
    <div className="card mb-4 flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
      <span className="rounded-xl bg-slate-800/70 px-2 py-1">
        Last updated: <b>{lastUpdated ? new Date(lastUpdated).toLocaleString() : "N/A"}</b>
      </span>
      <span className="rounded-xl bg-slate-800/50 px-2 py-1 text-slate-300">As-of: {asOfDate ?? "N/A"}</span>
      <span className="rounded-xl bg-slate-800/50 px-2 py-1 text-slate-300">Auto-refresh: {autoRefreshLabel}</span>
      <span className="rounded-xl bg-slate-800/50 px-2 py-1 text-slate-300">TZ: {timezone}</span>
      <span className="rounded-xl bg-accent/15 px-2 py-1 text-accent">Source: {providerLabel}</span>
    </div>
  );
}
