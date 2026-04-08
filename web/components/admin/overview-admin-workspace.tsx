"use client";

import { RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { AdminPageHeader } from "./admin-page-header";
import { AdminStatCard } from "./admin-stat-card";
import { OverviewEtfUniversePanel } from "./overview-etf-universe-panel";
import { OverviewLayoutGroupsPanel } from "./overview-layout-groups-panel";
import { useOverviewAdminConfig } from "./use-overview-admin-config";
import { useOverviewEtfAdmin } from "./use-overview-etf-admin";

type TabKey = "layout" | "etf";

const tabs: Array<{ key: TabKey; label: string; description: string }> = [
  {
    key: "layout",
    label: "Layout & Groups",
    description: "Sections, groups, columns, and ticker assignments.",
  },
  {
    key: "etf",
    label: "ETF Universe",
    description: "Sector and industry ETF sources, sync status, and diagnostics.",
  },
];

export function OverviewAdminWorkspace() {
  const [activeTab, setActiveTab] = useState<TabKey>("layout");
  const configState = useOverviewAdminConfig();
  const etfState = useOverviewEtfAdmin();

  const sectionCount = configState.data?.sections.length ?? 0;
  const groupCount = useMemo(
    () => (configState.data?.sections ?? []).reduce((sum, section) => sum + section.groups.length, 0),
    [configState.data],
  );
  const itemCount = useMemo(
    () => (configState.data?.sections ?? []).reduce(
      (sum, section) => sum + section.groups.reduce((groupSum, group) => groupSum + group.items.length, 0),
      0,
    ),
    [configState.data],
  );
  const etfCount = etfState.sectorEtfs.length + etfState.industryEtfs.length;
  const etfIssues = etfState.etfSyncStatus.filter(
    (row) => row.error || !row.lastSyncedAt || String(row.status ?? "").toLowerCase() !== "synced",
  ).length;

  return (
    <div className="space-y-6">
      <AdminPageHeader
        eyebrow="Admin"
        title="Overview Configuration"
        description="Manage the dashboard structure, maintain tracked ETF universes, and keep the overview configuration coherent without leaving the admin workspace."
        actions={(
          <button
            className="rounded-2xl border border-borderSoft/80 bg-panelSoft/65 px-4 py-2 text-sm text-slate-200 transition hover:bg-panelSoft"
            onClick={() => {
              if (activeTab === "layout") {
                void configState.load();
              } else {
                void etfState.load();
              }
            }}
            type="button"
          >
            <span className="inline-flex items-center gap-2"><RefreshCw className="h-4 w-4" />Refresh Active View</span>
          </button>
        )}
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <AdminStatCard label="Sections" value={sectionCount} helper="Top-level overview surfaces." />
        <AdminStatCard label="Groups" value={groupCount} helper="Ticker groupings across sections." />
        <AdminStatCard label="Tickers" value={itemCount} helper="Configured rows across all groups." />
        <AdminStatCard label="Tracked ETFs" value={etfCount} helper="Sector and industry universe entries." />
        <AdminStatCard
          label="ETF Sync Alerts"
          value={etfIssues}
          helper={etfIssues > 0 ? "Tracked ETFs need sync attention." : "All tracked ETF sync rows look healthy."}
          tone={etfIssues > 0 ? "warning" : "success"}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            className={`rounded-2xl border px-4 py-3 text-left transition ${
              activeTab === tab.key
                ? "border-accent/40 bg-accent/10 text-text"
                : "border-borderSoft/70 bg-panelSoft/35 text-slate-300 hover:border-accent/20 hover:bg-panelSoft/60"
            }`}
            onClick={() => setActiveTab(tab.key)}
            type="button"
          >
            <div className="text-sm font-semibold">{tab.label}</div>
            <div className="mt-1 text-xs text-slate-400">{tab.description}</div>
          </button>
        ))}
      </div>

      {activeTab === "layout" ? (
        <OverviewLayoutGroupsPanel state={configState} />
      ) : (
        <OverviewEtfUniversePanel state={etfState} />
      )}
    </div>
  );
}
