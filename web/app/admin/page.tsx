import { AdminBuilder } from "@/components/admin-builder";
import { AdminSection } from "@/components/admin-section";
import { ManualRefreshButton } from "@/components/manual-refresh-button";
import { PeerGroupsAdminPanel } from "@/components/peer-groups-admin-panel";
import { WatchlistCompilerAdminPanel } from "@/components/watchlist-compiler-admin-panel";

export default function AdminPage() {
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <ManualRefreshButton page="admin" />
      </div>
      <AdminSection
        title="Dashboard Builder"
        description="Configure groups, ranking windows, visible columns, and tickers without code changes."
      >
        <AdminBuilder />
      </AdminSection>
      <AdminSection
        title="Peer Groups"
        description="Manage peer groups, assign tickers, and run peer seeding workflows."
        defaultOpen={false}
      >
        <PeerGroupsAdminPanel />
      </AdminSection>
      <AdminSection
        title="Watchlist Compiler"
        description="Manage saved public TradingView watchlists and daily compile schedules."
        defaultOpen={false}
      >
        <WatchlistCompilerAdminPanel />
      </AdminSection>
    </div>
  );
}
