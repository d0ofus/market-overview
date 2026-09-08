import { EodPublicationMonitor } from "@/components/eod-publication-monitor";
import { BreadthPanels } from "@/components/breadth-panels";
import { EqualWeightComps } from "@/components/equal-weight-comps";
import { ManualRefreshButton } from "@/components/manual-refresh-button";
import { StatusBar } from "@/components/status-bar";
import { getBreadthDashboard, type BreadthDashboardSnapshot } from "@/lib/api";
import { breadthMembershipPresentation } from "@/lib/breadth-membership";

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
  const membershipPresentations = new Map(universes.map((universe) => [universe.universeId, breadthMembershipPresentation(universe.membership)]));
  const membershipProblems = [...membershipPresentations.values()].filter((item) => item.severity !== "normal");
  const severity = universes.some((universe) => universe.freshness === "missing" || universe.staleTradingSessions >= 2)
    || membershipProblems.some((item) => item.severity === "red")
    ? "red"
    : universes.some((universe) => universe.freshness !== "fresh" || universe.staleTradingSessions === 1) || membershipProblems.length > 0
      ? "amber"
      : null;
  const displayedDates = Array.from(new Set(universes
    .map((universe) => universe.displayedAsOfSession)
    .filter((value): value is string => Boolean(value))));

  return (
    <div className="space-y-4">
      <EodPublicationMonitor scope="breadth" generationId={dashboard?.generationId} />
      <StatusBar
        asOfDate={summary.asOfDate}
        lastUpdated={dashboard?.generatedAt ?? null}
        timezone="Australia/Melbourne"
        autoRefreshLabel="Within 2 hours of US cash close (including early closes)"
        providerLabel={dashboard?.providerLabel ?? "Alpaca completed daily bars; Yahoo same-session fallback; source-labelled price returns."}
      />

      <div className={`card px-4 py-3 text-sm ${severity === "red" ? "border-red-500/60 bg-red-950/30 text-red-100" : severity === "amber" ? "border-amber-500/60 bg-amber-950/25 text-amber-100" : "text-slate-200"}`}>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
          <span><span className="text-slate-400">Expected session:</span> {dashboard?.expectedAsOfSession ?? "Unavailable"}</span>
          <span><span className="text-slate-400">Displaying data from:</span> {displayedDates.length ? displayedDates.join(", ") : "No validated generation"}</span>
          <span><span className="text-slate-400">Generation:</span> {dashboard?.generationId ?? "None"}</span>
        </div>
        {(dashboard?.warning || severity) && (
          <p className="mt-2">
            {dashboard?.warning ?? (staleTradingSessions > 0
              ? `Breadth is ${staleTradingSessions} trading session${staleTradingSessions === 1 ? "" : "s"} stale.`
              : membershipProblems.length > 0
                ? `${membershipProblems.length} universe${membershipProblems.length === 1 ? " has" : "s have"} degraded or unavailable membership verification.`
                : "Breadth coverage or freshness is incomplete.")}
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
        {universes.length > 0 && (
          <div className="mt-3 overflow-x-auto border-t border-borderSoft/60 pt-2">
            <table className="min-w-full text-xs">
              <thead className="text-slate-400"><tr>
                <th className="px-2 py-1 text-left">Universe</th>
                <th className="px-2 py-1 text-left">Membership used</th>
                <th className="px-2 py-1 text-left">Source date</th>
                <th className="px-2 py-1 text-left">Last verification (UTC)</th>
              </tr></thead>
              <tbody>{universes.map((universe) => {
                const presentation = membershipPresentations.get(universe.universeId)!;
                const verifiedAt = universe.membership.verifiedAt;
                return <tr key={`membership-${universe.universeId}`} className="border-t border-borderSoft/40 align-top">
                  <td className="px-2 py-2 text-slate-200">{universe.universeName}</td>
                  <td className="px-2 py-2" title={universe.membership.versionId ?? undefined}>
                    <div className={presentation.severity === "red" ? "text-red-300" : presentation.severity === "amber" ? "text-amber-300" : "text-slate-200"}>{presentation.label}</div>
                    <div className="max-w-md text-slate-400">{presentation.detail}</div>
                    <div className="text-slate-400">{universe.membership.source ?? "Source unavailable"}</div>
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 text-slate-300">{universe.membership.sourceAsOfDate ?? "Unavailable"}</td>
                  <td className="whitespace-nowrap px-2 py-2 text-slate-300">{verifiedAt && Number.isFinite(Date.parse(verifiedAt))
                    ? new Date(verifiedAt).toISOString().slice(0, 16).replace("T", " ") : "Unavailable"}</td>
                </tr>;
              })}</tbody>
            </table>
          </div>
        )}
      </div>

      <div className="flex justify-end">
        <ManualRefreshButton page="breadth" />
      </div>
      <BreadthPanels
        rows={histories["sp500-core"] ?? []}
        summary={summary}
        histories={histories}
        exchangeSessionDates={dashboard?.exchangeSessionDates}
        footer={<EqualWeightComps />}
      />
    </div>
  );
}
