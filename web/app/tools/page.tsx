import { PositionSizing } from "@/components/position-sizing";
import { ManualRefreshButton } from "@/components/manual-refresh-button";

export default function ToolsPage() {
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">04 Position Sizing Calculator</h2>
      <div className="flex justify-end">
        <ManualRefreshButton page="tools" />
      </div>
      <PositionSizing />
    </div>
  );
}
