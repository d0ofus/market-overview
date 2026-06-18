"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  adminFetch,
  getAdminBraveUsage,
  getAdminCronJobs,
  getAdminMarketCommentarySettings,
  getAdminSymbolCatalogStatus,
  refreshMarketCommentary,
  resetAdminMarketCommentarySettings,
  updateAdminMarketCommentarySettings,
  type AdminBraveUsageResponse,
  type AdminCronJobsResponse,
  type MarketCommentarySettings,
  type SymbolCatalogStatus,
} from "@/lib/api";
import { ManualRefreshButton } from "@/components/manual-refresh-button";
import { AdminCard } from "./admin-card";
import { AdminPageHeader } from "./admin-page-header";
import { AdminStatCard } from "./admin-stat-card";
import { CronJobConfigurationPanel } from "./cron-job-configuration-panel";
import { EmptyState } from "./empty-state";
import { InlineAlert } from "./inline-alert";
import {
  EtfSyncStatusRow,
  OverviewAdminConfig,
} from "./overview-admin-shared";

const pageTargetOptions = [
  { value: "overview", label: "Overview" },
  { value: "breadth", label: "Breadth" },
  { value: "sectors", label: "Sector Tracker" },
  { value: "thirteenf", label: "13F Tracker" },
  { value: "scans", label: "Scans" },
  { value: "pattern-scanner", label: "Pattern Scanner" },
  { value: "watchlist-compiler", label: "Watchlist Compiler" },
  { value: "gappers", label: "Gappers" },
  { value: "admin", label: "Admin" },
] as const;

type RefreshTarget = (typeof pageTargetOptions)[number]["value"];

const braveCallerLabels: Record<string, string> = {
  daily_commentary: "Daily",
  weekly_review: "Weekly",
  fomc: "FOMC",
};

export function AdminOperationsDashboard() {
  const [config, setConfig] = useState<OverviewAdminConfig | null>(null);
  const [sectorEtfCount, setSectorEtfCount] = useState(0);
  const [industryEtfCount, setIndustryEtfCount] = useState(0);
  const [etfSyncStatus, setEtfSyncStatus] = useState<EtfSyncStatusRow[]>([]);
  const [symbolStatus, setSymbolStatus] = useState<SymbolCatalogStatus | null>(null);
  const [commentarySettings, setCommentarySettings] = useState<MarketCommentarySettings | null>(null);
  const [cronJobs, setCronJobs] = useState<AdminCronJobsResponse | null>(null);
  const [braveUsage, setBraveUsage] = useState<AdminBraveUsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ tone: "success" | "danger" | "info"; text: string } | null>(null);
  const [schedulePageTarget, setSchedulePageTarget] = useState<RefreshTarget>("overview");
  const [savingCommentarySettings, setSavingCommentarySettings] = useState(false);
  const [resettingCommentarySettings, setResettingCommentarySettings] = useState(false);
  const [runningCommentaryRefresh, setRunningCommentaryRefresh] = useState(false);
  const [runningPageUpdate, setRunningPageUpdate] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [configRes, sectorRes, industryRes, syncRes, symbolRes, commentarySettingsRes, cronJobsRes, braveUsageRes] = await Promise.all([
        adminFetch<OverviewAdminConfig>("/api/admin/config"),
        adminFetch<{ rows: Array<Record<string, unknown>> }>("/api/etfs/sector"),
        adminFetch<{ rows: Array<Record<string, unknown>> }>("/api/etfs/industry"),
        adminFetch<{ rows: EtfSyncStatusRow[] }>("/api/admin/etf-sync-status?limit=200"),
        getAdminSymbolCatalogStatus().catch(() => null),
        getAdminMarketCommentarySettings().catch(() => null),
        getAdminCronJobs().catch(() => null),
        getAdminBraveUsage(14).catch(() => null),
      ]);
      setConfig(configRes);
      setSectorEtfCount(sectorRes.rows?.length ?? 0);
      setIndustryEtfCount(industryRes.rows?.length ?? 0);
      setEtfSyncStatus(syncRes.rows ?? []);
      setSymbolStatus(symbolRes);
      setCommentarySettings(commentarySettingsRes);
      setCronJobs(cronJobsRes);
      setBraveUsage(braveUsageRes);
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Failed to load admin operations." });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const stats = useMemo(() => {
    const sectionCount = config?.sections.length ?? 0;
    const groupCount = config?.sections.reduce((sum, section) => sum + section.groups.length, 0) ?? 0;
    const tickerCount = config?.sections.reduce(
      (sum, section) => sum + section.groups.reduce((groupSum, group) => groupSum + group.items.length, 0),
      0,
    ) ?? 0;
    const pendingSyncCount = etfSyncStatus.filter((row) => row.status === "pending").length;

    return {
      sectionCount,
      groupCount,
      tickerCount,
      pendingSyncCount,
    };
  }, [config, etfSyncStatus]);

  const braveCallerBreakdown = useMemo(() => {
    const totals = new Map<string, { apiCallCount: number; apiErrorCount: number; cacheHitCount: number }>();
    for (const row of braveUsage?.rows ?? []) {
      const current = totals.get(row.caller) ?? { apiCallCount: 0, apiErrorCount: 0, cacheHitCount: 0 };
      current.apiCallCount += row.apiCallCount;
      current.apiErrorCount += row.apiErrorCount;
      current.cacheHitCount += row.cacheHitCount;
      totals.set(row.caller, current);
    }
    return ["daily_commentary", "weekly_review", "fomc"].map((caller) => ({
      caller,
      ...(totals.get(caller) ?? { apiCallCount: 0, apiErrorCount: 0, cacheHitCount: 0 }),
    }));
  }, [braveUsage]);

  const saveCommentarySettings = async () => {
    if (!commentarySettings) return;
    setSavingCommentarySettings(true);
    try {
      const response = await updateAdminMarketCommentarySettings({
        id: commentarySettings.id,
        enabled: commentarySettings.enabled,
        systemPromptTemplate: commentarySettings.systemPromptTemplate,
        staticSources: commentarySettings.staticSources.map((source) => ({
          ...source,
          url: source.url?.trim() || null,
          timestamp: source.timestamp?.trim() || null,
          note: source.note?.trim() || null,
        })),
        braveQueries: commentarySettings.braveQueries.map((query) => query.trim()).filter(Boolean),
        scheduleEnabled: commentarySettings.scheduleEnabled,
        scheduleTimezone: commentarySettings.scheduleTimezone,
        scheduleLocalTime: commentarySettings.scheduleLocalTime,
        scheduleDays: commentarySettings.scheduleDays,
      });
      setCommentarySettings(response.settings);
      setMessage({ tone: "success", text: "Saved market commentary settings." });
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Failed to save market commentary settings." });
    } finally {
      setSavingCommentarySettings(false);
    }
  };

  const resetCommentarySettings = async () => {
    setResettingCommentarySettings(true);
    try {
      const response = await resetAdminMarketCommentarySettings();
      setCommentarySettings(response.settings);
      setMessage({ tone: "success", text: "Reset market commentary settings to defaults." });
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Failed to reset market commentary settings." });
    } finally {
      setResettingCommentarySettings(false);
    }
  };

  const runCommentaryRefreshNow = async () => {
    setRunningCommentaryRefresh(true);
    try {
      const response = await refreshMarketCommentary(true);
      setMessage({ tone: response.ok ? "success" : "info", text: response.warning ?? "Market commentary refresh completed." });
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Failed to run commentary refresh." });
    } finally {
      setRunningCommentaryRefresh(false);
    }
  };

  const runSelectedPageUpdate = async () => {
    setRunningPageUpdate(true);
    try {
      const result = await adminFetch<{ ok: boolean; refreshedTickers: number; notes?: string }>("/api/admin/refresh-page", {
        method: "POST",
        body: JSON.stringify({ page: schedulePageTarget }),
      });
      setMessage({
        tone: "success",
        text: result.notes ?? `Ran ${schedulePageTarget} update: ${result.refreshedTickers} tickers refreshed.`,
      });
      await load();
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Failed to run selected page refresh." });
    } finally {
      setRunningPageUpdate(false);
    }
  };

  return (
    <section className="space-y-6">
      <AdminPageHeader
        eyebrow="Admin"
        title="Operations Home"
        description="Monitor configuration health, run high-impact refresh actions, and manage the worker-driven schedule without changing any backend contracts."
        actions={<button className="rounded-xl border border-borderSoft/80 bg-panelSoft/70 px-4 py-2 text-sm text-slate-200 transition hover:bg-panelSoft" onClick={() => void load()} type="button">Reload</button>}
      />

      {message ? <InlineAlert tone={message.tone === "danger" ? "danger" : message.tone}>{message.text}</InlineAlert> : null}

      {loading ? (
        <div className="grid gap-4 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="admin-surface h-28 animate-pulse rounded-3xl bg-panelSoft/60" />
          ))}
        </div>
      ) : null}

      {!loading && config ? (
        <>
          <div className="grid gap-4 xl:grid-cols-4">
            <AdminStatCard label="Sections" value={stats.sectionCount} helper="Dashboard sections currently configured." />
            <AdminStatCard label="Groups" value={stats.groupCount} helper="Overview and supporting config groups." />
            <AdminStatCard label="Configured Tickers" value={stats.tickerCount} helper="Ticker rows controlled from admin config." />
            <AdminStatCard
              label="ETF Sync Pending"
              value={stats.pendingSyncCount}
              helper={`${sectorEtfCount + industryEtfCount} tracked ETFs across sector and industry lists.`}
              tone={stats.pendingSyncCount > 0 ? "warning" : "success"}
            />
          </div>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr),minmax(18rem,0.9fr)]">
            <div className="space-y-6">
              <AdminCard title="Quick Actions" description="Use these for immediate worker refreshes and targeted operational tasks.">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="rounded-2xl border border-borderSoft/70 bg-panelSoft/45 p-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Manual Refresh</p>
                    <div className="mt-4 flex flex-wrap gap-3">
                      <ManualRefreshButton page="overview" idleLabel="Refresh Overview Data" />
                      <ManualRefreshButton page="admin" idleLabel="Refresh Admin Data" />
                    </div>
                  </div>
                  <div className="rounded-2xl border border-borderSoft/70 bg-panelSoft/45 p-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Targeted Page Update</p>
                    <div className="mt-4 grid gap-3">
                      <select
                        className="rounded-2xl border border-borderSoft/80 bg-panel px-3 py-2 text-sm text-text"
                        value={schedulePageTarget}
                        onChange={(event) => setSchedulePageTarget(event.target.value as RefreshTarget)}
                      >
                        {pageTargetOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                      <button
                        className="rounded-2xl border border-borderSoft/80 bg-panelSoft/70 px-4 py-2 text-sm text-slate-200 transition hover:bg-panelSoft disabled:opacity-60"
                        disabled={runningPageUpdate}
                        onClick={() => void runSelectedPageUpdate()}
                        type="button"
                      >
                        {runningPageUpdate ? "Running..." : "Run Selected Page Update"}
                      </button>
                    </div>
                  </div>
                </div>
              </AdminCard>

              <CronJobConfigurationPanel data={cronJobs} onUpdated={setCronJobs} />

              {commentarySettings ? (
                <AdminCard
                  title="Market Commentary Settings"
                  description="Edit the Gemini report prompt, source references, and Brave Search queries. Scheduled generation is configured in Cron Job Configuration."
                >
                  <div className="space-y-5">
                    <div className="grid gap-3 md:grid-cols-2">
                      <button
                        className="rounded-2xl border border-borderSoft/80 bg-panel px-4 py-2 text-left text-sm text-slate-200 transition hover:bg-panelSoft"
                        onClick={() => setCommentarySettings((current) => current ? { ...current, enabled: !current.enabled } : current)}
                        type="button"
                      >
                        Generation: {commentarySettings.enabled ? "Enabled" : "Disabled"}
                      </button>
                      <button
                        className="rounded-2xl border border-accent/50 bg-accent/15 px-4 py-2 text-left text-sm font-medium text-accent transition hover:bg-accent/20 disabled:opacity-60"
                        disabled={runningCommentaryRefresh}
                        onClick={() => void runCommentaryRefreshNow()}
                        type="button"
                      >
                        {runningCommentaryRefresh ? "Running..." : "Run Commentary Refresh Now"}
                      </button>
                    </div>

                    <label className="block text-xs text-slate-300">
                      Prompt template
                      <textarea
                        className="mt-2 min-h-[18rem] w-full rounded-2xl border border-borderSoft/80 bg-panel p-3 font-mono text-xs leading-5 text-text"
                        value={commentarySettings.systemPromptTemplate}
                        onChange={(event) => setCommentarySettings((current) => current ? { ...current, systemPromptTemplate: event.target.value } : current)}
                      />
                    </label>

                    <div className="space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Static Source References</p>
                          <p className="mt-1 text-xs text-slate-400">These are included in the source audit before Brave results are added.</p>
                        </div>
                        <button
                          className="rounded-2xl border border-borderSoft/80 bg-panel px-3 py-2 text-xs text-slate-200 transition hover:bg-panelSoft"
                          onClick={() => setCommentarySettings((current) => current ? {
                            ...current,
                            staticSources: [...current.staticSources, { sourceName: "", url: "", dataUsed: "", timestamp: null, note: "" }],
                          } : current)}
                          type="button"
                        >
                          Add Source
                        </button>
                      </div>
                      <div className="space-y-3">
                        {commentarySettings.staticSources.map((source, index) => (
                          <div key={index} className="rounded-2xl border border-borderSoft/70 bg-panelSoft/45 p-3">
                            <div className="grid gap-3 lg:grid-cols-[minmax(10rem,0.8fr),minmax(12rem,1fr),minmax(12rem,1fr),auto]">
                              <input
                                className="h-10 rounded-xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                                placeholder="Source name"
                                value={source.sourceName}
                                onChange={(event) => setCommentarySettings((current) => current ? {
                                  ...current,
                                  staticSources: current.staticSources.map((item, itemIndex) => itemIndex === index ? { ...item, sourceName: event.target.value } : item),
                                } : current)}
                              />
                              <input
                                className="h-10 rounded-xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                                placeholder="https://..."
                                value={source.url ?? ""}
                                onChange={(event) => setCommentarySettings((current) => current ? {
                                  ...current,
                                  staticSources: current.staticSources.map((item, itemIndex) => itemIndex === index ? { ...item, url: event.target.value } : item),
                                } : current)}
                              />
                              <input
                                className="h-10 rounded-xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                                placeholder="Data used"
                                value={source.dataUsed}
                                onChange={(event) => setCommentarySettings((current) => current ? {
                                  ...current,
                                  staticSources: current.staticSources.map((item, itemIndex) => itemIndex === index ? { ...item, dataUsed: event.target.value } : item),
                                } : current)}
                              />
                              <button
                                className="h-10 rounded-xl border border-borderSoft/80 bg-panel px-3 text-xs text-slate-300 transition hover:bg-panelSoft disabled:opacity-50"
                                disabled={commentarySettings.staticSources.length <= 1}
                                onClick={() => setCommentarySettings((current) => current ? {
                                  ...current,
                                  staticSources: current.staticSources.filter((_, itemIndex) => itemIndex !== index),
                                } : current)}
                                type="button"
                              >
                                Remove
                              </button>
                            </div>
                            <input
                              className="mt-3 h-10 w-full rounded-xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                              placeholder="Optional note"
                              value={source.note ?? ""}
                              onChange={(event) => setCommentarySettings((current) => current ? {
                                ...current,
                                staticSources: current.staticSources.map((item, itemIndex) => itemIndex === index ? { ...item, note: event.target.value } : item),
                              } : current)}
                            />
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Brave Search Query Templates</p>
                          <p className="mt-1 text-xs text-slate-400">Supported variables: {"{nyDate}"}, {"{sessionDate}"}, {"{latestCompletedSessionDate}"}, {"{marketStatus}"}.</p>
                        </div>
                        <button
                          className="rounded-2xl border border-borderSoft/80 bg-panel px-3 py-2 text-xs text-slate-200 transition hover:bg-panelSoft"
                          onClick={() => setCommentarySettings((current) => current ? { ...current, braveQueries: [...current.braveQueries, ""] } : current)}
                          type="button"
                        >
                          Add Query
                        </button>
                      </div>
                      <div className="space-y-2">
                        {commentarySettings.braveQueries.map((query, index) => (
                          <div key={index} className="grid gap-2 md:grid-cols-[minmax(0,1fr),auto]">
                            <input
                              className="h-10 rounded-xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                              value={query}
                              onChange={(event) => setCommentarySettings((current) => current ? {
                                ...current,
                                braveQueries: current.braveQueries.map((item, itemIndex) => itemIndex === index ? event.target.value : item),
                              } : current)}
                            />
                            <button
                              className="h-10 rounded-xl border border-borderSoft/80 bg-panel px-3 text-xs text-slate-300 transition hover:bg-panelSoft disabled:opacity-50"
                              disabled={commentarySettings.braveQueries.length <= 1}
                              onClick={() => setCommentarySettings((current) => current ? {
                                ...current,
                                braveQueries: current.braveQueries.filter((_, itemIndex) => itemIndex !== index),
                              } : current)}
                              type="button"
                            >
                              Remove
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="flex flex-wrap justify-end gap-3">
                      <button
                        className="h-11 rounded-2xl border border-borderSoft/80 bg-panel px-4 text-sm text-slate-200 transition hover:bg-panelSoft disabled:opacity-60"
                        disabled={resettingCommentarySettings}
                        onClick={() => void resetCommentarySettings()}
                        type="button"
                      >
                        {resettingCommentarySettings ? "Resetting..." : "Reset Defaults"}
                      </button>
                      <button
                        className="h-11 rounded-2xl bg-accent px-4 text-sm font-medium text-slate-950 transition hover:brightness-110 disabled:opacity-60"
                        disabled={savingCommentarySettings}
                        onClick={() => void saveCommentarySettings()}
                        type="button"
                      >
                        {savingCommentarySettings ? "Saving..." : "Save Commentary Settings"}
                      </button>
                    </div>
                  </div>
                </AdminCard>
              ) : null}

            </div>

            <div className="space-y-6">
              <AdminCard title="Admin Areas" description="Jump straight into the focused workspace for each admin domain.">
                <div className="grid gap-3">
                  <Link className="rounded-2xl border border-borderSoft/80 bg-panelSoft/55 px-4 py-3 text-sm text-slate-200 transition hover:border-accent/30 hover:bg-panelSoft/70" href="/admin/overview">
                    Overview Configuration
                  </Link>
                  <Link className="rounded-2xl border border-borderSoft/80 bg-panelSoft/55 px-4 py-3 text-sm text-slate-200 transition hover:border-accent/30 hover:bg-panelSoft/70" href="/admin/peer-groups">
                    Peer Groups
                  </Link>
                  <Link className="rounded-2xl border border-borderSoft/80 bg-panelSoft/55 px-4 py-3 text-sm text-slate-200 transition hover:border-accent/30 hover:bg-panelSoft/70" href="/admin/fundamentals">
                    Fundamentals
                  </Link>
                  <Link className="rounded-2xl border border-borderSoft/80 bg-panelSoft/55 px-4 py-3 text-sm text-slate-200 transition hover:border-accent/30 hover:bg-panelSoft/70" href="/admin/watchlist-compiler">
                    Watchlist Compiler
                  </Link>
                  <Link className="rounded-2xl border border-borderSoft/80 bg-panelSoft/55 px-4 py-3 text-sm text-slate-200 transition hover:border-accent/30 hover:bg-panelSoft/70" href="/admin/research-lab">
                    AI Research
                  </Link>
                </div>
              </AdminCard>

              <AdminCard title="Worker Health" description="Quick visibility into data volume and background status relevant to admin operations.">
                <div className="space-y-3 text-sm text-slate-300">
                  <div className="rounded-2xl border border-borderSoft/70 bg-panelSoft/45 px-4 py-3">
                    <div className="text-xs uppercase tracking-[0.2em] text-slate-500">ETF Universe</div>
                    <div className="mt-2">{sectorEtfCount} sector ETFs, {industryEtfCount} industry ETFs</div>
                  </div>
                  <div className="rounded-2xl border border-borderSoft/70 bg-panelSoft/45 px-4 py-3">
                    <div className="text-xs uppercase tracking-[0.2em] text-slate-500">Symbol Directory</div>
                    <div className="mt-2">
                      {symbolStatus
                        ? `${symbolStatus.activeCount} active, ${symbolStatus.inactiveCount} inactive, ${symbolStatus.manualCount} manual overrides`
                        : "Symbol directory status unavailable."}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-borderSoft/70 bg-panelSoft/45 px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-xs uppercase tracking-[0.2em] text-slate-500">Brave Search Usage</div>
                      <div className="text-xs text-slate-500">{braveUsage ? `${braveUsage.days}d` : "N/A"}</div>
                    </div>
                    {braveUsage ? (
                      <div className="mt-3 space-y-3">
                        <div className="grid grid-cols-3 gap-2 text-xs">
                          <div>
                            <div className="text-slate-500">Calls</div>
                            <div className="mt-1 text-base font-semibold text-text">{braveUsage.totals.apiCallCount}</div>
                          </div>
                          <div>
                            <div className="text-slate-500">Hits</div>
                            <div className="mt-1 text-base font-semibold text-text">{braveUsage.totals.cacheHitCount}</div>
                          </div>
                          <div>
                            <div className="text-slate-500">Errors</div>
                            <div className="mt-1 text-base font-semibold text-text">{braveUsage.totals.apiErrorCount}</div>
                          </div>
                        </div>
                        <div className="space-y-1">
                          {braveCallerBreakdown.map((row) => (
                            <div key={row.caller} className="flex items-center justify-between gap-3 text-xs text-slate-400">
                              <span>{braveCallerLabels[row.caller] ?? row.caller}</span>
                              <span>{row.apiCallCount} calls / {row.cacheHitCount} hits / {row.apiErrorCount} errors</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div className="mt-2">Brave usage unavailable.</div>
                    )}
                  </div>
                </div>
              </AdminCard>
            </div>
          </div>
        </>
      ) : null}

      {!loading && !config ? (
        <EmptyState
          title="Admin config unavailable"
          description="The admin worker did not return configuration data. Reload the page or verify that the worker is reachable from the current Vercel environment."
          action={<button className="rounded-2xl border border-borderSoft/80 bg-panelSoft/65 px-4 py-2 text-sm text-slate-200 transition hover:bg-panelSoft" onClick={() => void load()} type="button">Retry</button>}
        />
      ) : null}
    </section>
  );
}
