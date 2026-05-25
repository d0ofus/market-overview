"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  adminFetch,
  getAdminMarketCommentarySettings,
  getAdminSymbolCatalogStatus,
  getAdminWorkerSchedule,
  refreshMarketCommentary,
  resetAdminMarketCommentarySettings,
  setAdminSymbolCatalogSchedule,
  updateAdminMarketCommentarySettings,
  updateAdminWorkerSchedule,
  type MarketCommentarySettings,
  type SymbolCatalogStatus,
  type WorkerScheduleSettings,
} from "@/lib/api";
import { ManualRefreshButton } from "@/components/manual-refresh-button";
import { AdminCard } from "./admin-card";
import { AdminPageHeader } from "./admin-page-header";
import { AdminStatCard } from "./admin-stat-card";
import { EmptyState } from "./empty-state";
import { InlineAlert } from "./inline-alert";
import {
  buildRefreshLabel,
  DEFAULT_REFRESH_TIME,
  DEFAULT_REFRESH_TIMEZONE,
  EtfSyncStatusRow,
  OverviewAdminConfig,
  refreshTimezoneOptions,
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

const commentaryWeekdayOptions = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export function AdminOperationsDashboard() {
  const [config, setConfig] = useState<OverviewAdminConfig | null>(null);
  const [sectorEtfCount, setSectorEtfCount] = useState(0);
  const [industryEtfCount, setIndustryEtfCount] = useState(0);
  const [etfSyncStatus, setEtfSyncStatus] = useState<EtfSyncStatusRow[]>([]);
  const [symbolStatus, setSymbolStatus] = useState<SymbolCatalogStatus | null>(null);
  const [workerSchedule, setWorkerSchedule] = useState<WorkerScheduleSettings | null>(null);
  const [commentarySettings, setCommentarySettings] = useState<MarketCommentarySettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ tone: "success" | "danger" | "info"; text: string } | null>(null);
  const [refreshConfig, setRefreshConfig] = useState({
    id: "default",
    name: "Default Swing Dashboard",
    timezone: DEFAULT_REFRESH_TIMEZONE,
    eodRunLocalTime: DEFAULT_REFRESH_TIME,
    eodRunTimeLabel: buildRefreshLabel(DEFAULT_REFRESH_TIME, DEFAULT_REFRESH_TIMEZONE),
  });
  const [schedulePageTarget, setSchedulePageTarget] = useState<RefreshTarget>("overview");
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [savingWorkerSchedule, setSavingWorkerSchedule] = useState(false);
  const [savingSymbolSchedule, setSavingSymbolSchedule] = useState(false);
  const [savingCommentarySettings, setSavingCommentarySettings] = useState(false);
  const [resettingCommentarySettings, setResettingCommentarySettings] = useState(false);
  const [runningCommentaryRefresh, setRunningCommentaryRefresh] = useState(false);
  const [runningPageUpdate, setRunningPageUpdate] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [configRes, sectorRes, industryRes, syncRes, symbolRes, workerScheduleRes, commentarySettingsRes] = await Promise.all([
        adminFetch<OverviewAdminConfig>("/api/admin/config"),
        adminFetch<{ rows: Array<Record<string, unknown>> }>("/api/etfs/sector"),
        adminFetch<{ rows: Array<Record<string, unknown>> }>("/api/etfs/industry"),
        adminFetch<{ rows: EtfSyncStatusRow[] }>("/api/admin/etf-sync-status?limit=200"),
        getAdminSymbolCatalogStatus().catch(() => null),
        getAdminWorkerSchedule().catch(() => null),
        getAdminMarketCommentarySettings().catch(() => null),
      ]);
      setConfig(configRes);
      setSectorEtfCount(sectorRes.rows?.length ?? 0);
      setIndustryEtfCount(industryRes.rows?.length ?? 0);
      setEtfSyncStatus(syncRes.rows ?? []);
      setSymbolStatus(symbolRes);
      setWorkerSchedule(workerScheduleRes);
      setCommentarySettings(commentarySettingsRes);
      setRefreshConfig({
        id: configRes.id,
        name: configRes.name,
        timezone: configRes.timezone || DEFAULT_REFRESH_TIMEZONE,
        eodRunLocalTime: configRes.eodRunLocalTime || DEFAULT_REFRESH_TIME,
        eodRunTimeLabel: buildRefreshLabel(configRes.eodRunLocalTime || DEFAULT_REFRESH_TIME, configRes.timezone || DEFAULT_REFRESH_TIMEZONE),
      });
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

  const saveRefreshConfig = async () => {
    setSavingSchedule(true);
    try {
      const nextLabel = buildRefreshLabel(refreshConfig.eodRunLocalTime, refreshConfig.timezone);
      await adminFetch("/api/admin/config", {
        method: "PATCH",
        body: JSON.stringify({
          id: refreshConfig.id,
          name: refreshConfig.name.trim() || "Default Swing Dashboard",
          timezone: refreshConfig.timezone,
          eodRunLocalTime: refreshConfig.eodRunLocalTime,
          eodRunTimeLabel: nextLabel,
        }),
      });
      setRefreshConfig((current) => ({ ...current, eodRunTimeLabel: nextLabel }));
      setMessage({ tone: "success", text: "Saved refresh schedule." });
      await load();
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Failed to save refresh schedule." });
    } finally {
      setSavingSchedule(false);
    }
  };

  const saveWorkerSchedule = async () => {
    if (!workerSchedule) return;
    setSavingWorkerSchedule(true);
    try {
      const response = await updateAdminWorkerSchedule({
        id: workerSchedule.id,
        rsBackgroundEnabled: workerSchedule.rsBackgroundEnabled,
        rsBackgroundBatchSize: workerSchedule.rsBackgroundBatchSize,
        rsBackgroundMaxBatchesPerTick: workerSchedule.rsBackgroundMaxBatchesPerTick,
        rsBackgroundTimeBudgetMs: workerSchedule.rsBackgroundTimeBudgetMs,
        rsManualCacheReuseEnabled: workerSchedule.rsManualCacheReuseEnabled,
        rsSharedConfigSnapshotFanoutEnabled: workerSchedule.rsSharedConfigSnapshotFanoutEnabled,
        postCloseBarsEnabled: workerSchedule.postCloseBarsEnabled,
        postCloseBarsOffsetMinutes: workerSchedule.postCloseBarsOffsetMinutes,
        postCloseBarsBatchSize: workerSchedule.postCloseBarsBatchSize,
        postCloseBarsMaxBatchesPerTick: workerSchedule.postCloseBarsMaxBatchesPerTick,
        patternScanEnabled: workerSchedule.patternScanEnabled,
        patternScanOffsetMinutes: workerSchedule.patternScanOffsetMinutes,
        patternScanBatchSize: workerSchedule.patternScanBatchSize,
        patternScanMaxBatchesPerTick: workerSchedule.patternScanMaxBatchesPerTick,
      });
      setWorkerSchedule(response.settings);
      setMessage({ tone: "success", text: "Saved worker schedule settings." });
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Failed to save worker schedule settings." });
    } finally {
      setSavingWorkerSchedule(false);
    }
  };

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

  const toggleSymbolSchedule = async (enabled: boolean) => {
    setSavingSymbolSchedule(true);
    try {
      const response = await setAdminSymbolCatalogSchedule(enabled);
      setSymbolStatus(response.status);
      setMessage({ tone: "success", text: `Symbol catalog scheduling ${enabled ? "enabled" : "disabled"}.` });
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Failed to update symbol catalog scheduling." });
    } finally {
      setSavingSymbolSchedule(false);
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

              <AdminCard
                title="Daily Price Refresh Schedule"
                description="This controls the worker-driven daily schedule used for overview and related EOD workflows."
                actions={<span className="rounded-full border border-borderSoft/70 bg-panelSoft/50 px-3 py-1 text-xs text-slate-300">{refreshConfig.eodRunTimeLabel}</span>}
              >
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr),12rem,12rem,auto]">
                  <label className="text-xs text-slate-300">
                    Dashboard name
                    <input
                      className="mt-2 h-11 w-full rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                      value={refreshConfig.name}
                      onChange={(event) => setRefreshConfig((current) => ({ ...current, name: event.target.value }))}
                    />
                  </label>
                  <label className="text-xs text-slate-300">
                    Timezone
                    <select
                      className="mt-2 h-11 w-full rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                      value={refreshConfig.timezone}
                      onChange={(event) => setRefreshConfig((current) => ({ ...current, timezone: event.target.value }))}
                    >
                      {refreshTimezoneOptions.map((timezone) => (
                        <option key={timezone.value} value={timezone.value}>
                          {timezone.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs text-slate-300">
                    Local time
                    <input
                      type="time"
                      className="mt-2 h-11 w-full rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                      value={refreshConfig.eodRunLocalTime}
                      onChange={(event) => setRefreshConfig((current) => ({ ...current, eodRunLocalTime: event.target.value }))}
                    />
                  </label>
                  <div className="flex items-end">
                    <button
                      className="h-11 rounded-2xl bg-accent px-4 text-sm font-medium text-slate-950 transition hover:brightness-110 disabled:opacity-60"
                      disabled={savingSchedule}
                      onClick={() => void saveRefreshConfig()}
                      type="button"
                    >
                      {savingSchedule ? "Saving..." : "Save Schedule"}
                    </button>
                  </div>
                </div>
              </AdminCard>

              {commentarySettings ? (
                <AdminCard
                  title="Market Commentary Settings"
                  description="Edit the Gemini report prompt, source references, Brave Search queries, and scheduled daily generation from Operations."
                  actions={<span className="rounded-full border border-borderSoft/70 bg-panelSoft/50 px-3 py-1 text-xs text-slate-300">{commentarySettings.scheduleTimezone} {commentarySettings.scheduleLocalTime}</span>}
                >
                  <div className="space-y-5">
                    <div className="grid gap-3 md:grid-cols-3">
                      <button
                        className="rounded-2xl border border-borderSoft/80 bg-panel px-4 py-2 text-left text-sm text-slate-200 transition hover:bg-panelSoft"
                        onClick={() => setCommentarySettings((current) => current ? { ...current, enabled: !current.enabled } : current)}
                        type="button"
                      >
                        Generation: {commentarySettings.enabled ? "Enabled" : "Disabled"}
                      </button>
                      <button
                        className="rounded-2xl border border-borderSoft/80 bg-panel px-4 py-2 text-left text-sm text-slate-200 transition hover:bg-panelSoft"
                        onClick={() => setCommentarySettings((current) => current ? { ...current, scheduleEnabled: !current.scheduleEnabled } : current)}
                        type="button"
                      >
                        Schedule: {commentarySettings.scheduleEnabled ? "Enabled" : "Disabled"}
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

                    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr),12rem,16rem]">
                      <label className="text-xs text-slate-300">
                        Schedule timezone
                        <input
                          className="mt-2 h-11 w-full rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                          value={commentarySettings.scheduleTimezone}
                          onChange={(event) => setCommentarySettings((current) => current ? { ...current, scheduleTimezone: event.target.value } : current)}
                        />
                      </label>
                      <label className="text-xs text-slate-300">
                        Local time
                        <input
                          type="time"
                          className="mt-2 h-11 w-full rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                          value={commentarySettings.scheduleLocalTime}
                          onChange={(event) => setCommentarySettings((current) => current ? { ...current, scheduleLocalTime: event.target.value } : current)}
                        />
                      </label>
                      <div className="text-xs text-slate-300">
                        Schedule days
                        <div className="mt-2 flex flex-wrap gap-2">
                          {commentaryWeekdayOptions.map((day) => {
                            const active = commentarySettings.scheduleDays.includes(day);
                            return (
                              <button
                                key={day}
                                className={`rounded-full border px-3 py-1.5 text-xs transition ${
                                  active
                                    ? "border-accent/60 bg-accent/15 text-accent"
                                    : "border-borderSoft/80 bg-panel text-slate-300 hover:bg-panelSoft"
                                }`}
                                onClick={() => setCommentarySettings((current) => {
                                  if (!current) return current;
                                  const nextDays = active
                                    ? current.scheduleDays.filter((item) => item !== day)
                                    : [...current.scheduleDays, day];
                                  return { ...current, scheduleDays: nextDays };
                                })}
                                type="button"
                              >
                                {day.slice(0, 3)}
                              </button>
                            );
                          })}
                        </div>
                      </div>
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

              {workerSchedule ? (
                <AdminCard
                  title="Worker Schedules"
                  description="Control runtime worker behavior from admin while keeping the deployed Cloudflare cron cadence fixed."
                  actions={<span className="rounded-full border border-borderSoft/70 bg-panelSoft/50 px-3 py-1 text-xs text-slate-300">{workerSchedule.cronExpression}</span>}
                >
                  <div className="space-y-5">
                    <div className="rounded-2xl border border-borderSoft/70 bg-panelSoft/45 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Relative Strength Background</p>
                          <p className="mt-2 text-sm text-slate-300">Queued or running RS jobs keep advancing after the page closes, using the fixed worker cron and same-request background kicks. Batch size controls tickers per RS chunk, while max batches per tick controls how many chunks one worker pass can consume.</p>
                        </div>
                        <button
                          className="rounded-2xl border border-borderSoft/80 bg-panel px-4 py-2 text-sm text-slate-200 transition hover:bg-panelSoft"
                          onClick={() => setWorkerSchedule((current) => current ? { ...current, rsBackgroundEnabled: !current.rsBackgroundEnabled } : current)}
                          type="button"
                        >
                          {workerSchedule.rsBackgroundEnabled ? "Enabled" : "Disabled"}
                        </button>
                      </div>
                      <div className="mt-4 grid gap-4 md:grid-cols-3">
                        <button
                          className="rounded-2xl border border-borderSoft/80 bg-panel px-4 py-2 text-left text-sm text-slate-200 transition hover:bg-panelSoft"
                          onClick={() => setWorkerSchedule((current) => current ? { ...current, rsManualCacheReuseEnabled: !current.rsManualCacheReuseEnabled } : current)}
                          type="button"
                        >
                          Manual cache reuse: {workerSchedule.rsManualCacheReuseEnabled ? "Enabled" : "Disabled"}
                        </button>
                        <button
                          className="rounded-2xl border border-borderSoft/80 bg-panel px-4 py-2 text-left text-sm text-slate-200 transition hover:bg-panelSoft"
                          onClick={() => setWorkerSchedule((current) => current ? { ...current, rsSharedConfigSnapshotFanoutEnabled: !current.rsSharedConfigSnapshotFanoutEnabled } : current)}
                          type="button"
                        >
                          Shared config fanout: {workerSchedule.rsSharedConfigSnapshotFanoutEnabled ? "Enabled" : "Disabled"}
                        </button>
                        <label className="text-xs text-slate-300">
                          Tickers per RS batch
                          <input
                            type="number"
                            min={1}
                            max={500}
                            className="mt-2 h-11 w-full rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                            value={workerSchedule.rsBackgroundBatchSize}
                            onChange={(event) => setWorkerSchedule((current) => current ? {
                              ...current,
                              rsBackgroundBatchSize: Number(event.target.value || current.rsBackgroundBatchSize),
                            } : current)}
                          />
                        </label>
                        <label className="text-xs text-slate-300">
                          Max batches per tick
                          <input
                            type="number"
                            min={1}
                            max={100}
                            className="mt-2 h-11 w-full rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                            value={workerSchedule.rsBackgroundMaxBatchesPerTick}
                            onChange={(event) => setWorkerSchedule((current) => current ? {
                              ...current,
                              rsBackgroundMaxBatchesPerTick: Number(event.target.value || current.rsBackgroundMaxBatchesPerTick),
                            } : current)}
                          />
                        </label>
                        <label className="text-xs text-slate-300">
                          Time budget per tick (ms)
                          <input
                            type="number"
                            min={1000}
                            max={30000}
                            step={1000}
                            className="mt-2 h-11 w-full rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                            value={workerSchedule.rsBackgroundTimeBudgetMs}
                            onChange={(event) => setWorkerSchedule((current) => current ? {
                              ...current,
                              rsBackgroundTimeBudgetMs: Number(event.target.value || current.rsBackgroundTimeBudgetMs),
                            } : current)}
                          />
                        </label>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-borderSoft/70 bg-panelSoft/45 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Pattern Scanner</p>
                          <p className="mt-2 text-sm text-slate-300">Run the learned pattern scanner after post-close bars are available, writing scores into the separate pattern D1 database.</p>
                        </div>
                        <button
                          className="rounded-2xl border border-borderSoft/80 bg-panel px-4 py-2 text-sm text-slate-200 transition hover:bg-panelSoft"
                          onClick={() => setWorkerSchedule((current) => current ? { ...current, patternScanEnabled: !current.patternScanEnabled } : current)}
                          type="button"
                        >
                          {workerSchedule.patternScanEnabled ? "Enabled" : "Disabled"}
                        </button>
                      </div>
                      <div className="mt-4 grid gap-4 md:grid-cols-3">
                        <label className="text-xs text-slate-300">
                          Start offset after US close (min)
                          <input
                            type="number"
                            min={0}
                            max={360}
                            className="mt-2 h-11 w-full rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                            value={workerSchedule.patternScanOffsetMinutes}
                            onChange={(event) => setWorkerSchedule((current) => current ? {
                              ...current,
                              patternScanOffsetMinutes: Number(event.target.value || current.patternScanOffsetMinutes),
                            } : current)}
                          />
                        </label>
                        <label className="text-xs text-slate-300">
                          Tickers per batch
                          <input
                            type="number"
                            min={1}
                            max={500}
                            className="mt-2 h-11 w-full rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                            value={workerSchedule.patternScanBatchSize}
                            onChange={(event) => setWorkerSchedule((current) => current ? {
                              ...current,
                              patternScanBatchSize: Number(event.target.value || current.patternScanBatchSize),
                            } : current)}
                          />
                        </label>
                        <label className="text-xs text-slate-300">
                          Max pattern batches per tick
                          <input
                            type="number"
                            min={1}
                            max={20}
                            className="mt-2 h-11 w-full rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                            value={workerSchedule.patternScanMaxBatchesPerTick}
                            onChange={(event) => setWorkerSchedule((current) => current ? {
                              ...current,
                              patternScanMaxBatchesPerTick: Number(event.target.value || current.patternScanMaxBatchesPerTick),
                            } : current)}
                          />
                        </label>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-borderSoft/70 bg-panelSoft/45 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Post-Close Daily Bars</p>
                          <p className="mt-2 text-sm text-slate-300">Load the latest session bar for the active Nasdaq Trader-backed common-stock universe before scheduled RS cache work runs.</p>
                        </div>
                        <button
                          className="rounded-2xl border border-borderSoft/80 bg-panel px-4 py-2 text-sm text-slate-200 transition hover:bg-panelSoft"
                          onClick={() => setWorkerSchedule((current) => current ? { ...current, postCloseBarsEnabled: !current.postCloseBarsEnabled } : current)}
                          type="button"
                        >
                          {workerSchedule.postCloseBarsEnabled ? "Enabled" : "Disabled"}
                        </button>
                      </div>
                      <div className="mt-4 grid gap-4 md:grid-cols-3">
                        <label className="text-xs text-slate-300">
                          Start offset after US close (min)
                          <input
                            type="number"
                            min={0}
                            max={240}
                            className="mt-2 h-11 w-full rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                            value={workerSchedule.postCloseBarsOffsetMinutes}
                            onChange={(event) => setWorkerSchedule((current) => current ? {
                              ...current,
                              postCloseBarsOffsetMinutes: Number(event.target.value || current.postCloseBarsOffsetMinutes),
                            } : current)}
                          />
                        </label>
                        <label className="text-xs text-slate-300">
                          Tickers per batch
                          <input
                            type="number"
                            min={20}
                            max={2000}
                            className="mt-2 h-11 w-full rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                            value={workerSchedule.postCloseBarsBatchSize}
                            onChange={(event) => setWorkerSchedule((current) => current ? {
                              ...current,
                              postCloseBarsBatchSize: Number(event.target.value || current.postCloseBarsBatchSize),
                            } : current)}
                          />
                        </label>
                        <label className="text-xs text-slate-300">
                          Max bar batches per tick
                          <input
                            type="number"
                            min={1}
                            max={20}
                            className="mt-2 h-11 w-full rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                            value={workerSchedule.postCloseBarsMaxBatchesPerTick}
                            onChange={(event) => setWorkerSchedule((current) => current ? {
                              ...current,
                              postCloseBarsMaxBatchesPerTick: Number(event.target.value || current.postCloseBarsMaxBatchesPerTick),
                            } : current)}
                          />
                        </label>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-borderSoft/70 bg-panelSoft/45 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Symbol Catalog Schedule</p>
                          <p className="mt-2 text-sm text-slate-300">This stays separate from RS and nightly bars, but it lives in the same worker-operations surface for convenience.</p>
                        </div>
                        <button
                          className="rounded-2xl border border-borderSoft/80 bg-panel px-4 py-2 text-sm text-slate-200 transition hover:bg-panelSoft disabled:opacity-60"
                          disabled={!symbolStatus || savingSymbolSchedule}
                          onClick={() => void toggleSymbolSchedule(!(symbolStatus?.scheduledEnabled ?? false))}
                          type="button"
                        >
                          {savingSymbolSchedule ? "Saving..." : symbolStatus?.scheduledEnabled ? "Enabled" : "Disabled"}
                        </button>
                      </div>
                      <p className="mt-3 text-xs text-slate-500">
                        Fixed Cloudflare cron cadence: <span className="font-mono text-slate-300">{workerSchedule.cronExpression}</span>
                        <span className="ml-2 text-slate-400">Earnings gap scan runs daily after 8:00pm ET from this heartbeat.</span>
                      </p>
                    </div>

                    <div className="flex justify-end">
                      <button
                        className="h-11 rounded-2xl bg-accent px-4 text-sm font-medium text-slate-950 transition hover:brightness-110 disabled:opacity-60"
                        disabled={savingWorkerSchedule}
                        onClick={() => void saveWorkerSchedule()}
                        type="button"
                      >
                        {savingWorkerSchedule ? "Saving..." : "Save Worker Schedules"}
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
