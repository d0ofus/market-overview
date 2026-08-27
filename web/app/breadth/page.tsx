import { BreadthPanels } from "@/components/breadth-panels";
import { EqualWeightComps } from "@/components/equal-weight-comps";
import { ManualRefreshButton } from "@/components/manual-refresh-button";
import { StatusBar } from "@/components/status-bar";
import { getBreadthDashboard, type BreadthDashboardSnapshot } from "@/lib/api";

const universeOrder = ["sp500-core", "nasdaq-core", "nyse-core", "russell2000-core", "overall-market-proxy"];

export default async function BreadthPage() {
  const dashboard = await getBreadthDashboard(120).catch(() => null);
  const universes = dashboard?.universes ?? [];
  const universeById = new Map(universes.map((universe) => [universe.universeId, universe]));
  const histories = Object.fromEntries(universeOrder.map((universeId) => [
    universeId,
    universeById.get(universeId)?.history ?? [],
  ])) as Record<string, BreadthDashboardSnapshot[]>;
  const summary = {
    asOfDate: universes.find((universe) => universe.displayedAsOfSession)?.displayedAsOfSession ?? null,
    rows: universes.flatMap((universe) => universe.displayedSnapshot
      ? [{ ...universe.displayedSnapshot, universeName: universe.universeName }]
      : []),
    unavailable: universes.flatMap((universe) => universe.error
      ? [{ id: universe.universeId, name: universe.universeName, reason: universe.error.message }]
      : []),
  };
  if (!dashboard) {
    summary.unavailable.push({
      id: "breadth-dashboard",
      name: "Breadth dashboard",
      reason: "The market-data database or Breadth publication state is unavailable.",
    });
  }
  const staleTradingSessions = Math.max(0, ...universes.map((universe) => universe.staleTradingSessions));
  const severity = universes.some((universe) => universe.freshness === "missing" || universe.staleTradingSessions >= 2)
    ? "red"
    : universes.some((universe) => universe.freshness !== "fresh" || universe.staleTradingSessions === 1)
      ? "amber"
      : null;
  const displayedDates = Array.from(new Set(universes
    .map((universe) => universe.displayedAsOfSession)
    .filter((value): value is string => Boolean(value))));

  return (
    <div className="space-y-4">
      <StatusBar
        asOfDate={summary.asOfDate}
        lastUpdated={dashboard?.generatedAt ?? null}
        timezone="Australia/Melbourne"
        autoRefreshLabel="08:15 Australia/Melbourne (prev US close)"
        providerLabel={dashboard?.providerLabel ?? "Alpaca SIP split-adjusted completed daily bars; Alpaca IEX exact-session fallback."}
      />

      <div className={`card px-4 py-3 text-sm ${severity === "red" ? "border-red-500/60 bg-red-950/30 text-red-100" : severity === "amber" ? "border-amber-500/60 bg-amber-950/25 text-amber-100" : "text-slate-200"}`}>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
          <span><span className="text-slate-400">Expected session:</span> {dashboard?.expectedAsOfSession ?? "Unavailable"}</span>
          <span><span className="text-slate-400">Displaying data from:</span> {displayedDates.length ? displayedDates.join(", ") : "No validated generation"}</span>
          <span><span className="text-slate-400">Generation:</span> {dashboard?.generationId ?? "None"}</span>
        </div>
        {(dashboard?.warning || severity) && (
          <p className="mt-2">
            {dashboard?.warning ?? `Breadth is ${staleTradingSessions} trading session${staleTradingSessions === 1 ? "" : "s"} stale.`}
          </p>
        )}
        {universes.some((universe) => universe.error) && (
          <ul className="mt-2 space-y-1">
            {universes.filter((universe) => universe.error).map((universe) => (
              <li key={universe.universeId}>
                {universe.universeName}: {universe.error?.message} Coverage {universe.coveragePct.toFixed(1)}%/{universe.requiredCoveragePct}%; membership {universe.membership.source ?? "missing"} ({universe.membership.sourceAsOfDate ?? "unknown source date"}); repair inputs {universe.repairSourceCount}.
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex justify-end">
        <ManualRefreshButton page="breadth" />
      </div>
      <BreadthPanels
        rows={histories["sp500-core"] ?? []}
        summary={summary}
        histories={histories}
        footer={<EqualWeightComps />}
      />
    </div>
  );
}
