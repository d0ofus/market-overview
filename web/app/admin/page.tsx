import { AdminBuilder } from "@/components/admin-builder";
import { AdminSection } from "@/components/admin-section";
import { ManualRefreshButton } from "@/components/manual-refresh-button";
import { PeerGroupsAdminPanel } from "@/components/peer-groups-admin-panel";
import { WatchlistCompilerAdminPanel } from "@/components/watchlist-compiler-admin-panel";

export default function AdminPage() {
  const jumpTargets = [
    { href: "#admin-etf-watchlists", label: "ETF Watchlists" },
    { href: "#admin-overview", label: "Overview" },
    { href: "#admin-peer-groups", label: "Peer Groups" },
    { href: "#admin-watchlist-compiler", label: "Watchlist Compiler" },
  ];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <ManualRefreshButton page="admin" />
      </div>
      <div className="card p-3">
        <div className="flex flex-wrap gap-2">
          {jumpTargets.map((target) => (
            <a
              key={target.href}
              className="rounded bg-slate-800 px-3 py-1.5 text-sm text-slate-300 hover:bg-accent/20 hover:text-accent"
              href={target.href}
            >
              {target.label}
            </a>
          ))}
        </div>
      </div>
      <AdminSection
        title="Overview"
        description="Configure the /overview groups, ranking windows, visible columns, tickers, and ticker display names."
        anchorId="admin-overview"
      >
        <AdminBuilder />
      </AdminSection>
      <AdminSection
        title="Peer Groups"
        description="Manage peer groups, assign tickers, and run peer seeding workflows."
        anchorId="admin-peer-groups"
      >
        <PeerGroupsAdminPanel />
      </AdminSection>
      <AdminSection
        title="Watchlist Compiler"
        description="Manage saved public TradingView watchlists and daily compile schedules."
        anchorId="admin-watchlist-compiler"
      >
        <WatchlistCompilerAdminPanel />
      </AdminSection>
    </div>
  );
}
