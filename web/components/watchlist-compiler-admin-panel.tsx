"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  compileAdminWatchlistCompilerSet,
  createAdminWatchlistCompilerSet,
  createAdminWatchlistCompilerSource,
  deleteAdminWatchlistCompilerSet,
  deleteAdminWatchlistCompilerSource,
  getAdminWatchlistCompilerSets,
  getWatchlistCompilerSet,
  updateAdminWatchlistCompilerSet,
  updateAdminWatchlistCompilerSource,
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

const EMPTY_FORM = {
  name: "",
  slug: "",
  isActive: true,
  compileDaily: false,
  dailyCompileTimeLocal: "08:15",
  dailyCompileTimezone: "Australia/Sydney",
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
                  <button
                    key={set.id}
                    className={`w-full rounded border px-3 py-2 text-left ${set.id === selectedSetId ? "border-accent/60 bg-accent/10" : "border-borderSoft/60 hover:bg-slate-900/30"}`}
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
                        });
                      } catch (error) {
                        setMessage(error instanceof Error ? error.message : "Failed to load selected watchlist set.");
                      }
                    }}
                  >
                    <div className="text-sm font-semibold text-accent">{set.name}</div>
                    <div className="text-[11px] text-slate-400">{set.sourceCount} sources | {set.compileDaily ? "daily" : "manual"}</div>
                  </button>
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
              <label className="flex items-center gap-2 text-sm text-slate-300">
                <input type="checkbox" checked={form.compileDaily} onChange={(event) => setForm((current) => ({ ...current, compileDaily: event.target.checked }))} />
                Compile Daily
              </label>
              <label className="block text-xs text-slate-300">
                Daily Time
                <input type="time" className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm" value={form.dailyCompileTimeLocal} onChange={(event) => setForm((current) => ({ ...current, dailyCompileTimeLocal: event.target.value }))} />
              </label>
              <label className="block text-xs text-slate-300">
                Timezone
                <select className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm" value={form.dailyCompileTimezone} onChange={(event) => setForm((current) => ({ ...current, dailyCompileTimezone: event.target.value }))}>
                  {TIMEZONE_OPTIONS.map((timezone) => (
                    <option key={timezone} value={timezone}>{timezone}</option>
                  ))}
                </select>
              </label>
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
                      await updateAdminWatchlistCompilerSet(selectedSetId, form);
                      await load(selectedSetId);
                      flashMessage("Watchlist set updated.");
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
