"use client";

import { useEffect, useState } from "react";
import { Copy, Loader2 } from "lucide-react";
import {
  compileAdminWatchlistCompilerSet,
  createAdminWatchlistCompilerSet,
  createAdminWatchlistCompilerSource,
  deleteAdminWatchlistCompilerSet,
  deleteAdminWatchlistCompilerSource,
  duplicateAdminWatchlistCompilerSet,
  getAdminWatchlistCompilerSets,
  getWatchlistCompilerSet,
  updateAdminWatchlistCompilerSet,
  updateAdminWatchlistCompilerSource,
  type WatchlistFactorConfig,
  type WatchlistFactorKey,
  type WatchlistCompilerSetDetail,
  type WatchlistCompilerSetRow,
} from "@/lib/api";
import { AdminCard } from "@/components/admin/admin-card";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { AdminStatCard } from "@/components/admin/admin-stat-card";
import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import { EmptyState } from "@/components/admin/empty-state";
import { InlineAlert } from "@/components/admin/inline-alert";

const TIMEZONE_OPTIONS = [
  "Australia/Sydney",
  "Australia/Melbourne",
  "Asia/Singapore",
  "America/New_York",
];

type WatchlistSetForm = {
  name: string;
  slug: string;
  isActive: boolean;
  compileDaily: boolean;
  dailyCompileTimeLocal: string;
  dailyCompileTimezone: string;
  factorConfig: WatchlistFactorConfig;
};

const EMPTY_FACTOR_CONFIG: WatchlistFactorConfig = {
  enabled: {
    priceAboveSma200: true,
    priceAbove: true,
    marketCapAbove: true,
    within52WeekHigh: true,
    priorStrongMove: true,
    avg10dDollarVolume: true,
    increasingVolumeProfile: true,
    averageTradingRangePct: true,
  },
  thresholds: {
    priceAbove: { minPrice: 10 },
    marketCapAbove: { minMarketCapMillions: 500 },
    within52WeekHigh: { maxDistancePct: 15 },
    priorStrongMove: { movePct: 50, lookbackMonths: 3 },
    strongSector: { lookbackMonths: 3 },
    avg10dDollarVolume: { minDollarVolumeMillions: 20 },
    increasingVolumeProfile: { lookbackMonths: 3, minTrendPct: 0 },
    acceleratingRevenueGrowth: { minAccelerationPct: 0 },
    acceleratingEpsGrowth: { minAccelerationPct: 0 },
    averageTradingRangePct: { minAtrPct: 3 },
  },
};

const FACTOR_DEFINITIONS: Array<{
  key: WatchlistFactorKey;
  label: string;
  inputs: Array<{
    group: keyof WatchlistFactorConfig["thresholds"];
    field: string;
    label: string;
    suffix?: string;
    min?: number;
    step?: number;
  }>;
}> = [
  { key: "priceAboveSma200", label: "Price > 200 SMA", inputs: [] },
  { key: "priceAbove", label: "Price > $X", inputs: [{ group: "priceAbove", field: "minPrice", label: "Min price", suffix: "$", min: 0, step: 0.01 }] },
  { key: "marketCapAbove", label: "Market Cap > $X Million", inputs: [{ group: "marketCapAbove", field: "minMarketCapMillions", label: "Min cap", suffix: "M", min: 0, step: 1 }] },
  { key: "within52WeekHigh", label: "Within X% of 52-week high", inputs: [{ group: "within52WeekHigh", field: "maxDistancePct", label: "Max distance", suffix: "%", min: 0, step: 0.1 }] },
  { key: "priorStrongMove", label: "Prior strong move", inputs: [
    { group: "priorStrongMove", field: "movePct", label: "Move", suffix: "%", min: 0, step: 0.1 },
    { group: "priorStrongMove", field: "lookbackMonths", label: "Lookback", suffix: "mo", min: 1, step: 1 },
  ] },
  { key: "strongSector", label: "In a strong sector", inputs: [{ group: "strongSector", field: "lookbackMonths", label: "Lookback", suffix: "mo", min: 1, step: 1 }] },
  { key: "avg10dDollarVolume", label: "Average 10D dollar volume > $X Million", inputs: [{ group: "avg10dDollarVolume", field: "minDollarVolumeMillions", label: "Min value", suffix: "M", min: 0, step: 1 }] },
  { key: "increasingVolumeProfile", label: "Increasing volume profile", inputs: [
    { group: "increasingVolumeProfile", field: "lookbackMonths", label: "Lookback", suffix: "mo", min: 1, step: 1 },
    { group: "increasingVolumeProfile", field: "minTrendPct", label: "Min trend", suffix: "%", step: 0.1 },
  ] },
  { key: "positiveRevenueGrowth", label: "Positive latest quarter revenue growth", inputs: [] },
  { key: "positiveEpsGrowth", label: "Positive latest quarter EPS growth", inputs: [] },
  { key: "acceleratingRevenueGrowth", label: "Accelerating revenue growth", inputs: [{ group: "acceleratingRevenueGrowth", field: "minAccelerationPct", label: "Min accel.", suffix: "pt", step: 0.1 }] },
  { key: "acceleratingEpsGrowth", label: "Accelerating EPS growth", inputs: [{ group: "acceleratingEpsGrowth", field: "minAccelerationPct", label: "Min accel.", suffix: "pt", step: 0.1 }] },
  { key: "averageTradingRangePct", label: "Average trading range % > X%", inputs: [{ group: "averageTradingRangePct", field: "minAtrPct", label: "Min range", suffix: "%", min: 0, step: 0.1 }] },
];

function normalizeFactorConfig(value: WatchlistFactorConfig | null | undefined): WatchlistFactorConfig {
  const enabled = value
    ? Object.fromEntries(FACTOR_DEFINITIONS.map((factor) => [factor.key, value.enabled?.[factor.key] === true])) as Partial<Record<WatchlistFactorKey, boolean>>
    : { ...EMPTY_FACTOR_CONFIG.enabled };
  return {
    enabled,
    thresholds: {
      priceAbove: { ...EMPTY_FACTOR_CONFIG.thresholds.priceAbove, ...(value?.thresholds?.priceAbove ?? {}) },
      marketCapAbove: { ...EMPTY_FACTOR_CONFIG.thresholds.marketCapAbove, ...(value?.thresholds?.marketCapAbove ?? {}) },
      within52WeekHigh: { ...EMPTY_FACTOR_CONFIG.thresholds.within52WeekHigh, ...(value?.thresholds?.within52WeekHigh ?? {}) },
      priorStrongMove: { ...EMPTY_FACTOR_CONFIG.thresholds.priorStrongMove, ...(value?.thresholds?.priorStrongMove ?? {}) },
      strongSector: { ...EMPTY_FACTOR_CONFIG.thresholds.strongSector, ...(value?.thresholds?.strongSector ?? {}) },
      avg10dDollarVolume: { ...EMPTY_FACTOR_CONFIG.thresholds.avg10dDollarVolume, ...(value?.thresholds?.avg10dDollarVolume ?? {}) },
      increasingVolumeProfile: { ...EMPTY_FACTOR_CONFIG.thresholds.increasingVolumeProfile, ...(value?.thresholds?.increasingVolumeProfile ?? {}) },
      acceleratingRevenueGrowth: { ...EMPTY_FACTOR_CONFIG.thresholds.acceleratingRevenueGrowth, ...(value?.thresholds?.acceleratingRevenueGrowth ?? {}) },
      acceleratingEpsGrowth: { ...EMPTY_FACTOR_CONFIG.thresholds.acceleratingEpsGrowth, ...(value?.thresholds?.acceleratingEpsGrowth ?? {}) },
      averageTradingRangePct: { ...EMPTY_FACTOR_CONFIG.thresholds.averageTradingRangePct, ...(value?.thresholds?.averageTradingRangePct ?? {}) },
    },
  };
}

function factorConfigSignature(value: WatchlistFactorConfig | null | undefined): string {
  return JSON.stringify(normalizeFactorConfig(value));
}

function activeSourceCount(value: WatchlistCompilerSetDetail | null): number {
  return value?.sources.filter((source) => source.isActive).length ?? 0;
}

const EMPTY_FORM: WatchlistSetForm = {
  name: "",
  slug: "",
  isActive: true,
  compileDaily: false,
  dailyCompileTimeLocal: "08:15",
  dailyCompileTimezone: "Australia/Sydney",
  factorConfig: normalizeFactorConfig(null),
};

export function WatchlistCompilerAdminPanel() {
  const [sets, setSets] = useState<WatchlistCompilerSetRow[]>([]);
  const [selectedSetId, setSelectedSetId] = useState<string | null>(null);
  const [detail, setDetail] = useState<WatchlistCompilerSetDetail | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [newSourceName, setNewSourceName] = useState("");
  const [newSourceUrl, setNewSourceUrl] = useState("");
  const [newSourceSections, setNewSourceSections] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [deleteSetOpen, setDeleteSetOpen] = useState(false);
  const [deleteSetBusy, setDeleteSetBusy] = useState(false);
  const [sourceToDelete, setSourceToDelete] = useState<{ id: string; label: string } | null>(null);
  const [deleteSourceBusy, setDeleteSourceBusy] = useState(false);
  const [duplicatingSetId, setDuplicatingSetId] = useState<string | null>(null);

  const flashMessage = (next: string, timeoutMs = 4000) => {
    setMessage(next);
    window.setTimeout(() => {
      setMessage((current) => current === next ? null : current);
    }, timeoutMs);
  };

  const load = async (preferredId?: string | null) => {
    setLoading(true);
    try {
      const setsRes = await getAdminWatchlistCompilerSets();
      const rows = setsRes.rows ?? [];
      setSets(rows);
      const nextId = preferredId ?? selectedSetId ?? rows[0]?.id ?? null;
      setSelectedSetId(nextId);
      if (nextId) {
        const nextDetail = await getWatchlistCompilerSet(nextId);
        setDetail(nextDetail);
        setForm({
          name: nextDetail.name,
          slug: nextDetail.slug,
          isActive: nextDetail.isActive,
          compileDaily: nextDetail.compileDaily,
          dailyCompileTimeLocal: nextDetail.dailyCompileTimeLocal ?? "08:15",
          dailyCompileTimezone: nextDetail.dailyCompileTimezone ?? "Australia/Sydney",
          factorConfig: normalizeFactorConfig(nextDetail.factorConfig),
        });
      } else {
        setDetail(null);
        setForm(EMPTY_FORM);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load watchlist compiler admin data.");
    } finally {
      setLoading(false);
    }
  };

  const ensureDraftSet = async (): Promise<string | null> => {
    if (selectedSetId) return selectedSetId;
    if (!form.name.trim()) {
      setMessage("Enter a set name first, or save the set before adding source URLs.");
      return null;
    }
    const created = await createAdminWatchlistCompilerSet(form);
    await load(created.id);
    return created.id;
  };

  const addDraftSourceToSet = async (setId: string): Promise<boolean> => {
    if (!newSourceUrl.trim()) return false;
    await createAdminWatchlistCompilerSource(setId, {
      sourceName: newSourceName.trim() || null,
      sourceUrl: newSourceUrl.trim(),
      sourceSections: newSourceSections.trim() || null,
      isActive: true,
    });
    setNewSourceName("");
    setNewSourceUrl("");
    setNewSourceSections("");
    return true;
  };

  const saveSourceChange = async (
    sourceId: string,
    payload: { sourceName?: string | null; sourceUrl?: string; sourceSections?: string | null; sortOrder?: number; isActive?: boolean },
    successMessage: string,
  ) => {
    try {
      await updateAdminWatchlistCompilerSource(sourceId, payload);
      await load(selectedSetId);
      flashMessage(successMessage);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to update source.");
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const handleDeleteSet = async () => {
    if (!selectedSetId) return;
    setDeleteSetBusy(true);
    try {
      await deleteAdminWatchlistCompilerSet(selectedSetId);
      await load(null);
      setDeleteSetOpen(false);
      flashMessage("Watchlist set deleted.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to delete watchlist set.");
    } finally {
      setDeleteSetBusy(false);
    }
  };

  const handleDeleteSource = async () => {
    if (!sourceToDelete) return;
    setDeleteSourceBusy(true);
    try {
      await deleteAdminWatchlistCompilerSource(sourceToDelete.id);
      await load(selectedSetId);
      flashMessage("Source URL deleted.");
      setSourceToDelete(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to delete source URL.");
    } finally {
      setDeleteSourceBusy(false);
    }
  };

  const handleDuplicateSet = async (setId: string, setName: string) => {
    setDuplicatingSetId(setId);
    setMessage(null);
    try {
      const duplicated = await duplicateAdminWatchlistCompilerSet(setId);
      await load(duplicated.id);
      flashMessage(`Duplicated ${setName}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to duplicate watchlist set.");
    } finally {
      setDuplicatingSetId(null);
    }
  };

  const setFactorEnabled = (key: WatchlistFactorKey, enabled: boolean) => {
    setForm((current) => ({
      ...current,
      factorConfig: {
        ...current.factorConfig,
        enabled: {
          ...current.factorConfig.enabled,
          [key]: enabled,
        },
      },
    }));
  };

  const setFactorThreshold = (group: keyof WatchlistFactorConfig["thresholds"], field: string, value: string) => {
    const parsed = Number(value);
    setForm((current) => ({
      ...current,
      factorConfig: {
        ...current.factorConfig,
        thresholds: {
          ...current.factorConfig.thresholds,
          [group]: {
            ...current.factorConfig.thresholds[group],
            [field]: Number.isFinite(parsed) ? parsed : 0,
          },
        },
      },
    }));
  };

  return (
    <>
      <section className="space-y-6">
        <AdminPageHeader
          eyebrow="Admin"
          title="Watchlist Compiler"
          description="Manage saved TradingView watchlist sets, keep source URLs organised, and trigger compiles from a more focused workspace."
          actions={(
            <button
              className="rounded-2xl border border-borderSoft/80 bg-panelSoft/65 px-4 py-2 text-sm text-slate-200 transition hover:bg-panelSoft"
              onClick={() => void load(selectedSetId)}
              type="button"
            >
              Refresh Workspace
            </button>
          )}
        />

        {message ? <InlineAlert tone="info">{message}</InlineAlert> : null}

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <AdminStatCard label="Sets" value={sets.length} helper="Configured watchlist collections." />
          <AdminStatCard label="Sources" value={detail?.sources.length ?? 0} helper={selectedSetId ? "Sources on the selected set." : "Select a set to inspect its sources."} />
          <AdminStatCard label="Compile Mode" value={form.compileDaily ? "daily" : "manual"} helper="Current selected set cadence." />
          <AdminStatCard label="Selected Set" value={selectedSetId ? "editing" : "draft"} helper={selectedSetId ? form.name || "Saved set" : "New unsaved set"} tone={selectedSetId ? "success" : "info"} />
        </div>

        <div className="grid gap-4 xl:grid-cols-[20rem,minmax(0,1fr)]">
          <div className="space-y-4">
          <AdminCard
            title="Sets"
            description="Choose the watchlist set you want to edit or start a new draft."
            actions={(
              <button
                className="rounded-xl border border-borderSoft/80 bg-panelSoft/65 px-3 py-2 text-sm text-slate-200 transition hover:bg-panelSoft"
                onClick={() => {
                  setSelectedSetId(null);
                  setDetail(null);
                  setForm(EMPTY_FORM);
                }}
                type="button"
              >
                New
              </button>
            )}
          >
            {loading ? (
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading sets...
              </div>
            ) : (
              <div className="space-y-2">
                {sets.map((set) => (
                  <div
                    key={set.id}
                    className={`flex items-stretch gap-2 rounded border ${set.id === selectedSetId ? "border-accent/60 bg-accent/10" : "border-borderSoft/60 hover:bg-slate-900/30"}`}
                  >
                    <button
                      className="min-w-0 flex-1 px-3 py-2 text-left"
                      onClick={async () => {
                        try {
                          setSelectedSetId(set.id);
                          const nextDetail = await getWatchlistCompilerSet(set.id);
                          setDetail(nextDetail);
                          setForm({
                            name: nextDetail.name,
                            slug: nextDetail.slug,
                            isActive: nextDetail.isActive,
                            compileDaily: nextDetail.compileDaily,
                            dailyCompileTimeLocal: nextDetail.dailyCompileTimeLocal ?? "08:15",
                            dailyCompileTimezone: nextDetail.dailyCompileTimezone ?? "Australia/Sydney",
                            factorConfig: normalizeFactorConfig(nextDetail.factorConfig),
                          });
                        } catch (error) {
                          setMessage(error instanceof Error ? error.message : "Failed to load selected watchlist set.");
                        }
                      }}
                      type="button"
                    >
                      <div className="truncate text-sm font-semibold text-accent">{set.name}</div>
                      <div className="text-[11px] text-slate-400">{set.sourceCount} sources | {set.compileDaily ? "daily" : "manual"}</div>
                    </button>
                    <button
                      aria-label={`Duplicate ${set.name}`}
                      className="m-1 flex w-9 shrink-0 items-center justify-center rounded border border-borderSoft/70 text-slate-300 transition hover:border-accent/40 hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={Boolean(duplicatingSetId)}
                      onClick={() => void handleDuplicateSet(set.id, set.name)}
                      title={`Duplicate ${set.name}`}
                      type="button"
                    >
                      {duplicatingSetId === set.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Copy className="h-4 w-4" />}
                    </button>
                  </div>
                ))}
                {sets.length === 0 && <EmptyState title="No watchlist sets yet" description="Create your first set to begin managing source URLs and compile schedules." />}
              </div>
            )}
          </AdminCard>
          </div>

          <div className="space-y-4">
            <AdminCard
              title={selectedSetId ? "Edit Set" : "Create Set"}
              description={selectedSetId ? "Adjust the selected set definition and compile schedule." : "Create a new watchlist set and optional first source."}
            >
            <div className="grid gap-3 md:grid-cols-2">
              <label className="block text-xs text-slate-300">
                Name
                <input className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} />
              </label>
              <label className="block text-xs text-slate-300">
                Slug
                <input className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm" value={form.slug} onChange={(event) => setForm((current) => ({ ...current, slug: event.target.value }))} />
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-300">
                <input type="checkbox" checked={form.isActive} onChange={(event) => setForm((current) => ({ ...current, isActive: event.target.checked }))} />
                Active
              </label>
              <div className="rounded border border-borderSoft bg-panelSoft px-3 py-2 text-sm text-slate-300 md:col-span-2">
                <div className="font-semibold text-slate-100">
                  Compile schedule: {form.compileDaily ? "daily" : "manual"}
                </div>
                <div className="mt-1 text-xs text-slate-400">
                  {form.dailyCompileTimeLocal} {form.dailyCompileTimezone}. Edit this schedule from Operations.
                </div>
                <a className="mt-2 inline-flex rounded border border-accent/40 bg-accent/15 px-3 py-1.5 text-xs text-accent" href="/admin">
                  Manage in Operations
                </a>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                className="rounded border border-accent/40 bg-accent/15 px-3 py-1.5 text-sm text-accent disabled:opacity-50"
                disabled={saving || !form.name.trim()}
                onClick={async () => {
                  setSaving(true);
                  setMessage(null);
                  try {
                    if (selectedSetId) {
                      const factorConfigChanged = factorConfigSignature(form.factorConfig) !== factorConfigSignature(detail?.factorConfig);
                      await updateAdminWatchlistCompilerSet(selectedSetId, form);
                      const shouldAutoCompile = factorConfigChanged && activeSourceCount(detail) > 0;
                      if (shouldAutoCompile) {
                        try {
                          const result = await compileAdminWatchlistCompilerSet(selectedSetId);
                          await load(selectedSetId);
                          flashMessage(`Watchlist set updated and recompiled ${result.run.compiledRowCount} rows.`);
                        } catch (compileError) {
                          await load(selectedSetId);
                          setMessage(compileError instanceof Error ? `Watchlist set updated, but compile failed: ${compileError.message}` : "Watchlist set updated, but compile failed.");
                        }
                      } else {
                        await load(selectedSetId);
                        flashMessage("Watchlist set updated.");
                      }
                    } else {
                      const created = await createAdminWatchlistCompilerSet(form);
                      const addedDraftSource = await addDraftSourceToSet(created.id);
                      await load(created.id);
                      flashMessage(addedDraftSource ? "Watchlist set created and source URL added." : "Watchlist set created.");
                    }
                  } catch (error) {
                    setMessage(error instanceof Error ? error.message : "Failed to save watchlist set.");
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                {saving ? "Saving..." : "Save Set"}
              </button>
              {selectedSetId && (
                <>
                  <button
                    className="rounded border border-borderSoft px-3 py-1.5 text-sm text-slate-200"
                    onClick={async () => {
                      try {
                        const result = await compileAdminWatchlistCompilerSet(selectedSetId);
                        await load(selectedSetId);
                        flashMessage(`Compiled ${result.run.compiledRowCount} rows and ${result.run.uniqueTickerCount} unique tickers.`);
                      } catch (error) {
                        setMessage(error instanceof Error ? error.message : "Failed to compile watchlist set.");
                      }
                    }}
                  >
                    Compile Now
                  </button>
                  <button
                    className="rounded border border-red-500/40 px-3 py-1.5 text-sm text-red-300"
                    onClick={() => setDeleteSetOpen(true)}
                  >
                    Delete Set
                  </button>
                </>
              )}
            </div>
            </AdminCard>

            <AdminCard title="Factor Assessment" description="Saved with this set and applied to each new compile. Existing runs stay unchanged.">
              <div className="grid gap-2 lg:grid-cols-2">
                {FACTOR_DEFINITIONS.map((factor) => (
                  <div key={factor.key} className="rounded border border-borderSoft/60 bg-panelSoft/35 p-3">
                    <label className="flex items-start gap-2 text-sm font-medium text-slate-200">
                      <input
                        className="mt-1"
                        type="checkbox"
                        checked={form.factorConfig.enabled[factor.key] === true}
                        onChange={(event) => setFactorEnabled(factor.key, event.target.checked)}
                      />
                      <span>{factor.label}</span>
                    </label>
                    {factor.inputs.length > 0 ? (
                      <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        {factor.inputs.map((input) => {
                          const groupValue = form.factorConfig.thresholds[input.group] as Record<string, number>;
                          return (
                            <label key={`${factor.key}-${input.field}`} className="block text-[11px] text-slate-400">
                              {input.label}
                              <div className="mt-1 flex items-center gap-1">
                                <input
                                  className="min-w-0 flex-1 rounded border border-borderSoft bg-panel px-2 py-1.5 text-sm text-slate-100"
                                  min={input.min}
                                  step={input.step ?? 1}
                                  type="number"
                                  value={groupValue[input.field] ?? 0}
                                  onChange={(event) => setFactorThreshold(input.group, input.field, event.target.value)}
                                />
                                {input.suffix ? <span className="w-7 text-right text-[11px] text-slate-500">{input.suffix}</span> : null}
                              </div>
                            </label>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </AdminCard>

            <AdminCard title="Source URLs" description="Add, reorder, activate, or remove TradingView source URLs for the selected set.">
            <div className="space-y-3">
              <div className="flex gap-2">
                <input
                  className="w-64 rounded border border-borderSoft bg-panelSoft px-3 py-2 text-sm"
                  value={newSourceName}
                  onChange={(event) => setNewSourceName(event.target.value)}
                  placeholder="Scan name"
                />
                <input
                  className="w-full rounded border border-borderSoft bg-panelSoft px-3 py-2 text-sm"
                  value={newSourceUrl}
                  onChange={(event) => setNewSourceUrl(event.target.value)}
                  placeholder="https://www.tradingview.com/watchlists/34128913/"
                />
                <button
                  className="rounded border border-accent/40 bg-accent/15 px-3 py-2 text-sm text-accent disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!newSourceUrl.trim() || (!selectedSetId && !form.name.trim())}
                  onClick={async () => {
                    if (!newSourceUrl.trim()) return;
                    try {
                      const setId = await ensureDraftSet();
                      if (!setId) return;
                      await addDraftSourceToSet(setId);
                      await load(setId);
                      flashMessage("Watchlist URL added.");
                    } catch (error) {
                      setMessage(error instanceof Error ? error.message : "Failed to add source URL.");
                    }
                  }}
                >
                  {selectedSetId ? "Add URL" : "Create Set + Add URL"}
                </button>
              </div>
              <textarea
                className="min-h-20 w-full rounded border border-borderSoft bg-panelSoft px-3 py-2 text-sm"
                value={newSourceSections}
                onChange={(event) => setNewSourceSections(event.target.value)}
                placeholder={"Optional sections to include, one per line\nFOCUS LIST - READY FOR EXECUTION\nFOCUS LIST - CLOSE TO READY"}
              />
              <p className="text-xs text-slate-500">Leave blank to import the full watchlist. When populated, only matching TradingView section headers are included.</p>
              {!selectedSetId && (
                <p className="text-sm text-slate-400">Enter the set details above. The first source you add will create the set automatically.</p>
              )}
              {detail ? (
                <div className="space-y-2">
                  {detail.sources.map((source, index) => (
                    <div key={source.id} className="rounded border border-borderSoft/60 p-3">
                      <div className="mb-2 text-[11px] text-slate-500">{source.sourceName?.trim() || `Source ${index + 1}`}</div>
                      <input
                        className="mb-2 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm"
                        value={source.sourceName ?? ""}
                        onChange={(event) => {
                          const nextName = event.target.value;
                          setDetail((current) => current ? {
                            ...current,
                            sources: current.sources.map((row) => row.id === source.id ? { ...row, sourceName: nextName } : row),
                          } : current);
                        }}
                        onBlur={async (event) => {
                          await saveSourceChange(source.id, { sourceName: event.target.value.trim() || null }, "Source name saved.");
                        }}
                        placeholder={`Source ${index + 1} name`}
                      />
                      <input
                        className="w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm"
                        value={source.sourceUrl}
                        onChange={(event) => {
                          const nextUrl = event.target.value;
                          setDetail((current) => current ? {
                            ...current,
                            sources: current.sources.map((row) => row.id === source.id ? { ...row, sourceUrl: nextUrl } : row),
                          } : current);
                        }}
                        onBlur={async (event) => {
                          await saveSourceChange(source.id, { sourceUrl: event.target.value.trim() }, "Source URL saved.");
                        }}
                      />
                      <textarea
                        className="mt-2 min-h-20 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm"
                        value={source.sourceSections ?? ""}
                        onChange={(event) => {
                          const nextSections = event.target.value;
                          setDetail((current) => current ? {
                            ...current,
                            sources: current.sources.map((row) => row.id === source.id ? { ...row, sourceSections: nextSections } : row),
                          } : current);
                        }}
                        onBlur={async (event) => {
                          await saveSourceChange(source.id, { sourceSections: event.target.value.trim() || null }, "Source sections saved.");
                        }}
                        placeholder={"Optional sections to include, one per line\nFOCUS LIST - READY FOR EXECUTION"}
                      />
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button
                          className="rounded border border-borderSoft px-2 py-1 text-xs text-slate-300"
                          disabled={index === 0}
                          onClick={async () => {
                            const prev = detail.sources[index - 1];
                            if (!prev) return;
                            await saveSourceChange(source.id, { sortOrder: prev.sortOrder }, "Source order updated.");
                            await saveSourceChange(prev.id, { sortOrder: source.sortOrder }, "Source order updated.");
                          }}
                        >
                          Up
                        </button>
                        <button
                          className="rounded border border-borderSoft px-2 py-1 text-xs text-slate-300"
                          disabled={index === detail.sources.length - 1}
                          onClick={async () => {
                            const next = detail.sources[index + 1];
                            if (!next) return;
                            await saveSourceChange(source.id, { sortOrder: next.sortOrder }, "Source order updated.");
                            await saveSourceChange(next.id, { sortOrder: source.sortOrder }, "Source order updated.");
                          }}
                        >
                          Down
                        </button>
                        <button
                          className={`rounded border px-2 py-1 text-xs ${source.isActive ? "border-accent/40 text-accent" : "border-borderSoft text-slate-300"}`}
                          onClick={async () => {
                            await saveSourceChange(source.id, { isActive: !source.isActive }, source.isActive ? "Source marked inactive." : "Source marked active.");
                          }}
                        >
                          {source.isActive ? "Active" : "Inactive"}
                        </button>
                        <button
                          className="rounded border border-red-500/40 px-2 py-1 text-xs text-red-300"
                          onClick={() => setSourceToDelete({ id: source.id, label: source.sourceName?.trim() || source.sourceUrl })}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                  {detail.sources.length === 0 && <EmptyState title="No source URLs yet" description="Add the first source URL to give this watchlist set something to compile." />}
                </div>
              ) : (
                <EmptyState title="No set selected" description="Select a watchlist set or create a new one to start managing source URLs." />
              )}
            </div>
            </AdminCard>
          </div>
        </div>
      </section>

      <ConfirmDialog
        open={deleteSetOpen}
        title="Delete watchlist set?"
        description={selectedSetId ? `Delete ${form.name || "this watchlist set"} and all of its source URLs?` : "Delete the selected watchlist set?"}
        confirmLabel="Delete Set"
        tone="danger"
        busy={deleteSetBusy}
        onCancel={() => setDeleteSetOpen(false)}
        onConfirm={handleDeleteSet}
      />

      <ConfirmDialog
        open={Boolean(sourceToDelete)}
        title="Delete source URL?"
        description={sourceToDelete ? `Delete ${sourceToDelete.label} from the selected watchlist set?` : ""}
        confirmLabel="Delete Source"
        tone="danger"
        busy={deleteSourceBusy}
        onCancel={() => setSourceToDelete(null)}
        onConfirm={handleDeleteSource}
      />
    </>
  );
}
