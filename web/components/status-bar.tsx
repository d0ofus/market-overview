type Props = {
  asOfDate: string | null;
  lastUpdated: string | null;
  timezone: string;
  autoRefreshLabel: string;
  providerLabel: string;
};

export function StatusBar({ asOfDate, lastUpdated, timezone, autoRefreshLabel, providerLabel }: Props) {
  return (
    <div className="card mb-4 flex flex-wrap items-center gap-4 px-4 py-3 text-sm">
      <span>
        Last updated: <b>{lastUpdated ? new Date(lastUpdated).toLocaleString() : "N/A"}</b>
      </span>
      <span className="muted">As-of: {asOfDate ?? "N/A"}</span>
      <span className="muted">Auto-refresh: {autoRefreshLabel}</span>
      <span className="muted">TZ: {timezone}</span>
      <span className="rounded bg-accent/10 px-2 py-1 text-accent">Source: {providerLabel}</span>
    </div>
  );
}
