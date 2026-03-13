import { AdminBuilder } from "@/components/admin-builder";
import { ManualRefreshButton } from "@/components/manual-refresh-button";
import { PeerGroupsAdminPanel } from "@/components/peer-groups-admin-panel";
import { WatchlistCompilerAdminPanel } from "@/components/watchlist-compiler-admin-panel";

export default function AdminPage() {
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Dashboard Builder</h2>
      <p className="text-sm text-slate-400">
        Configure groups, ranking windows, visible columns, and tickers without code changes.
      </p>
      <div className="flex justify-end">
        <ManualRefreshButton page="admin" />
      </div>
      <AdminBuilder />
      <PeerGroupsAdminPanel />
      <WatchlistCompilerAdminPanel />
    </div>
  );
}
