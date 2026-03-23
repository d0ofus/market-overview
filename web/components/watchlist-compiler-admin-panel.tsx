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

  useEffect(() => {
    void load();
  }, []);

  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold">Watchlist Compiler</h3>
        <p className="text-sm text-slate-400">Manage saved TradingView watchlist sets, source URLs, and daily compile schedules.</p>
      </div>

      {message && <div className="card border border-borderSoft/70 p-3 text-sm text-slate-300">{message}</div>}

      <div className="grid gap-4 xl:grid-cols-[20rem,minmax(0,1fr)]">
        <div className="space-y-4">
          <div className="card p-3">
            <div className="mb-3 flex items-center justify-between">
              <h4 className="text-sm font-semibold text-slate-200">Sets</h4>
              <button
                className="rounded border border-borderSoft px-2 py-1 text-xs text-slate-300"
                onClick={() => {
                  setSelectedSetId(null);
                  setDetail(null);
                  setForm(EMPTY_FORM);
                }}
              >
                New
              </button>
            </div>
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
                    }}
                  >
                    <div className="text-sm font-semibold text-accent">{set.name}</div>
                    <div className="text-[11px] text-slate-400">{set.sourceCount} sources • {set.compileDaily ? "daily" : "manual"}</div>
                  </button>
                ))}
                {sets.length === 0 && <p className="text-xs text-slate-400">No watchlist sets yet.</p>}
              </div>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div className="card p-3">
            <div className="mb-2 text-sm font-semibold text-slate-200">{selectedSetId ? "Edit Set" : "Create Set"}</div>
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
                      setMessage("Watchlist set updated.");
                    } else {
                      const created = await createAdminWatchlistCompilerSet(form);
                      await load(created.id);
                      setMessage("Watchlist set created.");
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
                        setMessage(`Compiled ${result.run.compiledRowCount} rows and ${result.run.uniqueTickerCount} unique tickers.`);
                      } catch (error) {
                        setMessage(error instanceof Error ? error.message : "Failed to compile watchlist set.");
                      }
                    }}
                  >
                    Compile Now
                  </button>
                  <button
                    className="rounded border border-red-500/40 px-3 py-1.5 text-sm text-red-300"
                    onClick={async () => {
                      await deleteAdminWatchlistCompilerSet(selectedSetId);
                      await load(null);
                      setMessage("Watchlist set deleted.");
                    }}
                  >
                    Delete Set
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="card p-3">
            <div className="mb-2 text-sm font-semibold text-slate-200">Source URLs</div>
            <div className="space-y-3">
              <div className="flex gap-2">
                <input
                  className="w-64 rounded border border-borderSoft bg-panelSoft px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                  value={newSourceName}
                  onChange={(event) => setNewSourceName(event.target.value)}
                  placeholder="Scan name"
                  disabled={!selectedSetId}
                />
                <input
                  className="w-full rounded border border-borderSoft bg-panelSoft px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                  value={newSourceUrl}
                  onChange={(event) => setNewSourceUrl(event.target.value)}
                  placeholder="https://www.tradingview.com/watchlists/34128913/"
                  disabled={!selectedSetId}
                />
                <button
                  className="rounded border border-accent/40 bg-accent/15 px-3 py-2 text-sm text-accent disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!selectedSetId || !newSourceUrl.trim()}
                  onClick={async () => {
                    if (!selectedSetId || !newSourceUrl.trim()) return;
                    try {
                      await createAdminWatchlistCompilerSource(selectedSetId, {
                        sourceName: newSourceName.trim() || null,
                        sourceUrl: newSourceUrl.trim(),
                        sourceSections: newSourceSections.trim() || null,
                        isActive: true,
                      });
                      setNewSourceName("");
                      setNewSourceUrl("");
                      setNewSourceSections("");
                      await load(selectedSetId);
                      setMessage("Watchlist URL added.");
                    } catch (error) {
                      setMessage(error instanceof Error ? error.message : "Failed to add source URL.");
                    }
                  }}
                >
                  Add URL
                </button>
              </div>
              <textarea
                className="min-h-20 w-full rounded border border-borderSoft bg-panelSoft px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                value={newSourceSections}
                onChange={(event) => setNewSourceSections(event.target.value)}
                placeholder={"Optional sections to include, one per line\nFOCUS LIST - READY FOR EXECUTION\nFOCUS LIST - CLOSE TO READY"}
                disabled={!selectedSetId}
              />
              <p className="text-xs text-slate-500">Leave blank to import the full watchlist. When populated, only matching TradingView section headers are included.</p>
              {!selectedSetId && (
                <p className="text-sm text-slate-400">Create or select a watchlist set first, then add its TradingView URLs here.</p>
              )}
              {detail ? (
                <div className="space-y-2">
                  {detail.sources.map((source, index) => (
                    <div key={source.id} className="rounded border border-borderSoft/60 p-3">
                      <div className="mb-2 text-[11px] text-slate-500">{source.sourceName?.trim() || `Source ${index + 1}`}</div>
                      <input
                        className="mb-2 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm"
                        value={source.sourceName ?? ""}
                        onChange={async (event) => {
                          const nextName = event.target.value;
                          setDetail((current) => current ? {
                            ...current,
                            sources: current.sources.map((row) => row.id === source.id ? { ...row, sourceName: nextName } : row),
                          } : current);
                        }}
                        onBlur={async (event) => {
                          try {
                            await updateAdminWatchlistCompilerSource(source.id, { sourceName: event.target.value.trim() || null });
                            await load(selectedSetId);
                          } catch (error) {
                            setMessage(error instanceof Error ? error.message : "Failed to update source name.");
                          }
                        }}
                        placeholder={`Source ${index + 1} name`}
                      />
                      <input
                        className="w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm"
                        value={source.sourceUrl}
                        onChange={async (event) => {
                          const nextUrl = event.target.value;
                          setDetail((current) => current ? {
                            ...current,
                            sources: current.sources.map((row) => row.id === source.id ? { ...row, sourceUrl: nextUrl } : row),
                          } : current);
                        }}
                        onBlur={async (event) => {
                          try {
                            await updateAdminWatchlistCompilerSource(source.id, { sourceUrl: event.target.value.trim() });
                            await load(selectedSetId);
                          } catch (error) {
                            setMessage(error instanceof Error ? error.message : "Failed to update source URL.");
                          }
                        }}
                      />
                      <textarea
                        className="mt-2 min-h-20 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm"
                        value={source.sourceSections ?? ""}
                        onChange={async (event) => {
                          const nextSections = event.target.value;
                          setDetail((current) => current ? {
                            ...current,
                            sources: current.sources.map((row) => row.id === source.id ? { ...row, sourceSections: nextSections } : row),
                          } : current);
                        }}
                        onBlur={async (event) => {
                          try {
                            await updateAdminWatchlistCompilerSource(source.id, { sourceSections: event.target.value.trim() || null });
                            await load(selectedSetId);
                          } catch (error) {
                            setMessage(error instanceof Error ? error.message : "Failed to update source sections.");
                          }
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
                            await updateAdminWatchlistCompilerSource(source.id, { sortOrder: prev.sortOrder });
                            await updateAdminWatchlistCompilerSource(prev.id, { sortOrder: source.sortOrder });
                            await load(selectedSetId);
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
                            await updateAdminWatchlistCompilerSource(source.id, { sortOrder: next.sortOrder });
                            await updateAdminWatchlistCompilerSource(next.id, { sortOrder: source.sortOrder });
                            await load(selectedSetId);
                          }}
                        >
                          Down
                        </button>
                        <button
                          className={`rounded border px-2 py-1 text-xs ${source.isActive ? "border-accent/40 text-accent" : "border-borderSoft text-slate-300"}`}
                          onClick={async () => {
                            await updateAdminWatchlistCompilerSource(source.id, { isActive: !source.isActive });
                            await load(selectedSetId);
                          }}
                        >
                          {source.isActive ? "Active" : "Inactive"}
                        </button>
                        <button
                          className="rounded border border-red-500/40 px-2 py-1 text-xs text-red-300"
                          onClick={async () => {
                            await deleteAdminWatchlistCompilerSource(source.id);
                            await load(selectedSetId);
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                  {detail.sources.length === 0 && <p className="text-sm text-slate-400">No source URLs added yet.</p>}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
