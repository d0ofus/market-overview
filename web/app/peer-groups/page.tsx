import { PeerGroupsDashboard } from "@/components/peer-groups-dashboard";

export default function PeerGroupsPage() {
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Peer Groups</h2>
      <p className="text-sm text-slate-400">
        Search tickers, inspect self-managed peer memberships, and analyze selected peer sets with multi-chart views and Alpaca-backed runtime metrics.
      </p>
      <PeerGroupsDashboard />
    </div>
  );
}

