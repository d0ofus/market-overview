"use client";

import { Loader2, Pencil, RefreshCw, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { AdminCard } from "./admin-card";
import { ConfirmDialog } from "./confirm-dialog";
import { EmptyState } from "./empty-state";
import { InlineAlert } from "./inline-alert";
import type { useOverviewEtfAdmin } from "./use-overview-etf-admin";

type Props = {
  state: ReturnType<typeof useOverviewEtfAdmin>;
};

type DeleteIntent = {
  listType: "sector" | "industry";
  ticker: string;
  label: string;
};

function statusTone(status: string | null, error: string | null): "success" | "warning" | "danger" | "info" {
  if (error) return "danger";
  const normalized = String(status ?? "").toLowerCase();
  if (normalized.includes("fail") || normalized.includes("error")) return "danger";
  if (normalized.includes("pending") || normalized.includes("queued") || normalized.includes("running")) return "warning";
  if (normalized.includes("sync") || normalized.includes("ok") || normalized.includes("ready")) return "success";
  return "info";
}

export function OverviewEtfUniversePanel({ state }: Props) {
  const [deleteIntent, setDeleteIntent] = useState<DeleteIntent | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const syncWarnings = useMemo(
    () => state.etfSyncStatus.filter((row) => row.error || !row.lastSyncedAt || String(row.status ?? "").toLowerCase() !== "synced"),
    [state.etfSyncStatus],
  );

  const handleDelete = async () => {
    if (!deleteIntent) return;
    setDeleteBusy(true);
    try {
      await state.deleteEtf(deleteIntent.listType, deleteIntent.ticker);
      setDeleteIntent(null);
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <>
      {state.message ? (
        <InlineAlert tone={state.message.tone === "danger" ? "danger" : state.message.tone}>{state.message.text}</InlineAlert>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr),minmax(0,0.8fr)]">
        <AdminCard
          title="Diagnostics And Sync"
          description="Verify backend state for a single ETF, save a source override, or backfill missing constituent data."
          actions={(
            <button
              className="rounded-xl border border-borderSoft/80 bg-panelSoft/65 px-3 py-2 text-sm text-slate-200 transition hover:bg-panelSoft"
              onClick={() => void state.runBackfill()}
              type="button"
            >
              <span className="inline-flex items-center gap-2"><RefreshCw className="h-4 w-4" />Backfill Missing Constituents</span>
            </button>
          )}
        >
          <div className="space-y-5">
            {state.backfillMsg ? <InlineAlert tone="info">{state.backfillMsg}</InlineAlert> : null}

            <div className="grid gap-3 lg:grid-cols-[12rem,auto,auto]">
              <label className="text-xs text-slate-300">
                ETF ticker
                <input
                  className="mt-2 h-11 w-full rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                  value={state.diagTicker}
                  onChange={(event) => state.setDiagTicker(event.target.value.toUpperCase())}
                  placeholder="TAN"
                />
              </label>
              <div className="flex items-end">
                <button
                  className="w-full rounded-2xl border border-borderSoft/80 bg-panelSoft/65 px-4 py-2 text-sm text-slate-200 transition hover:bg-panelSoft disabled:opacity-60"
                  disabled={state.diagLoading}
                  onClick={() => void state.runDiagnostics(false)}
                  type="button"
                >
                  {state.diagLoading ? "Checking..." : "Check Backend + DB"}
                </button>
              </div>
              <div className="flex items-end">
                <button
                  className="w-full rounded-2xl bg-accent px-4 py-2 text-sm font-medium text-slate-950 transition hover:brightness-110 disabled:opacity-60"
                  disabled={state.diagLoading}
                  onClick={() => void state.runDiagnostics(true)}
                  type="button"
                >
                  {state.diagLoading ? "Syncing..." : "Sync Ticker + Verify"}
                </button>
              </div>
            </div>

            {state.diagMsg ? <InlineAlert tone="success">{state.diagMsg}</InlineAlert> : null}
            {state.diagError ? <InlineAlert tone="danger">{state.diagError}</InlineAlert> : null}

            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr),auto,auto]">
              <label className="text-xs text-slate-300">
                Source URL override
                <input
                  className="mt-2 h-11 w-full rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                  value={state.diagSourceUrl}
                  onChange={(event) => state.setDiagSourceUrl(event.target.value)}
                  placeholder="https://www.tradingview.com/symbols/..."
                />
              </label>
              <div className="flex items-end">
                <button
                  className="w-full rounded-2xl border border-borderSoft/80 bg-panelSoft/65 px-4 py-2 text-sm text-slate-200 transition hover:bg-panelSoft"
                  onClick={() => void state.saveSourceUrl(false)}
                  type="button"
                >
                  Save Source URL
                </button>
              </div>
              <div className="flex items-end">
                <button
                  className="w-full rounded-2xl border border-accent/30 bg-accent/10 px-4 py-2 text-sm text-accent transition hover:bg-accent/15"
                  onClick={() => void state.saveSourceUrl(true)}
                  type="button"
                >
                  Save + Sync
                </button>
              </div>
            </div>

            {state.diagResult ? (
              <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr),18rem]">
                <div className="overflow-hidden rounded-2xl border border-borderSoft/70">
                  <table className="min-w-full text-sm">
                    <tbody>
                      <tr className="border-b border-borderSoft/60 bg-panelSoft/30">
                        <td className="px-4 py-3 text-slate-400">Backend revision</td>
                        <td className="px-4 py-3 text-text">{state.diagResult.backendRevision ?? "-"}</td>
                      </tr>
                      <tr className="border-b border-borderSoft/60">
                        <td className="px-4 py-3 text-slate-400">Configured source URL</td>
                        <td className="px-4 py-3 break-all text-text">{state.diagResult.sourceUrl ?? "-"}</td>
                      </tr>
                      <tr className="border-b border-borderSoft/60 bg-panelSoft/30">
                        <td className="px-4 py-3 text-slate-400">Server time (UTC)</td>
                        <td className="px-4 py-3 text-text">{state.formatDateTimeCompact(state.diagResult.serverTimeUtc)}</td>
                      </tr>
                      <tr className="border-b border-borderSoft/60">
                        <td className="px-4 py-3 text-slate-400">Database connection</td>
                        <td className="px-4 py-3 text-text">{state.diagResult.db?.ok ? "OK" : `ERROR: ${state.diagResult.db?.error ?? "unknown"}`}</td>
                      </tr>
                      <tr className="border-b border-borderSoft/60 bg-panelSoft/30">
                        <td className="px-4 py-3 text-slate-400">Watchlist membership</td>
                        <td className="px-4 py-3 text-text">
                          {(state.diagResult.watchlists ?? []).length > 0
                            ? state.diagResult.watchlists.map((row) => row.listType).join(", ")
                            : "Not found in watchlists"}
                        </td>
                      </tr>
                      <tr className="border-b border-borderSoft/60">
                        <td className="px-4 py-3 text-slate-400">Sync status</td>
                        <td className="px-4 py-3 text-text">{state.diagResult.syncStatus?.status ?? "-"}</td>
                      </tr>
                      <tr className="border-b border-borderSoft/60 bg-panelSoft/30">
                        <td className="px-4 py-3 text-slate-400">Last synced</td>
                        <td className="px-4 py-3 text-text">{state.formatDateTimeCompact(state.diagResult.syncStatus?.lastSyncedAt)}</td>
                      </tr>
                      <tr className="border-b border-borderSoft/60">
                        <td className="px-4 py-3 text-slate-400">Cached constituents</td>
                        <td className="px-4 py-3 text-text">{state.diagResult.constituentSummary?.count ?? 0}</td>
                      </tr>
                      <tr className="bg-panelSoft/30">
                        <td className="px-4 py-3 text-slate-400">Sync error</td>
                        <td className="px-4 py-3 text-rose-200">{state.diagResult.syncStatus?.error ?? "-"}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <div className="space-y-3 rounded-2xl border border-borderSoft/70 bg-panelSoft/30 p-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">Top Constituents Sample</p>
                    <div className="mt-3 space-y-2">
                      {(state.diagResult.topConstituents ?? []).slice(0, 5).map((row) => (
                        <div key={row.ticker} className="flex items-center justify-between rounded-xl border border-borderSoft/60 bg-panel px-3 py-2 text-sm">
                          <span className="font-semibold text-accent">{row.ticker}</span>
                          <span className="text-slate-300">{typeof row.weight === "number" ? `${row.weight.toFixed(2)}%` : "-"}</span>
                        </div>
                      ))}
                      {(state.diagResult.topConstituents ?? []).length === 0 ? (
                        <p className="text-sm text-slate-400">No constituent sample returned for this ETF.</p>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </AdminCard>

        <AdminCard title="Tracked ETF Lists" description="Create and maintain the sector and industry ETF watchlists that feed the overview.">
          <div className="space-y-6">
            <div className="grid gap-3">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">Add sector ETF</p>
              <input
                className="h-11 rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                placeholder="Ticker (e.g. XLF)"
                value={state.sectorEtfForm.ticker}
                onBlur={() => void state.resolveFundName(state.sectorEtfForm.ticker, "sector")}
                onChange={(event) => state.setSectorEtfForm((current) => ({ ...current, ticker: event.target.value }))}
              />
              <input
                className="h-11 rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                placeholder="Fund name"
                value={state.sectorEtfForm.fundName}
                onChange={(event) => state.setSectorEtfForm((current) => ({ ...current, fundName: event.target.value }))}
              />
              <select
                className="h-11 rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                value={state.sectorEtfForm.parentSectorSelect}
                onChange={(event) => state.setSectorEtfForm((current) => ({ ...current, parentSectorSelect: event.target.value }))}
              >
                <option value="">Select parent sector...</option>
                {state.parentSectorOptions.map((option) => (
                  <option key={`sector-parent-${option}`} value={option}>{option}</option>
                ))}
              </select>
              <input
                className="h-11 rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                placeholder="Or enter new parent sector"
                value={state.sectorEtfForm.parentSectorNew}
                onChange={(event) => state.setSectorEtfForm((current) => ({ ...current, parentSectorNew: event.target.value }))}
              />
              <button
                className="rounded-2xl bg-accent px-4 py-2 text-sm font-medium text-slate-950 transition hover:brightness-110"
                onClick={() => void state.addSectorEtf()}
                type="button"
              >
                Add Sector ETF
              </button>
            </div>

            <div className="border-t border-borderSoft/70 pt-6">
              <div className="grid gap-3">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">Add industry ETF</p>
                <input
                  className="h-11 rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                  placeholder="Ticker (e.g. SMH)"
                  value={state.industryEtfForm.ticker}
                  onBlur={() => void state.resolveFundName(state.industryEtfForm.ticker, "industry")}
                  onChange={(event) => state.setIndustryEtfForm((current) => ({ ...current, ticker: event.target.value }))}
                />
                <input
                  className="h-11 rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                  placeholder="Fund name"
                  value={state.industryEtfForm.fundName}
                  onChange={(event) => state.setIndustryEtfForm((current) => ({ ...current, fundName: event.target.value }))}
                />
                <select
                  className="h-11 rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                  value={state.industryEtfForm.parentSectorSelect}
                  onChange={(event) => state.setIndustryEtfForm((current) => ({ ...current, parentSectorSelect: event.target.value }))}
                >
                  <option value="">Select parent sector...</option>
                  {state.parentSectorOptions.map((option) => (
                    <option key={`industry-parent-${option}`} value={option}>{option}</option>
                  ))}
                </select>
                <input
                  className="h-11 rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                  placeholder="Or enter new parent sector"
                  value={state.industryEtfForm.parentSectorNew}
                  onChange={(event) => state.setIndustryEtfForm((current) => ({ ...current, parentSectorNew: event.target.value }))}
                />
                <select
                  className="h-11 rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                  value={state.industryEtfForm.industrySelect}
                  onChange={(event) => state.setIndustryEtfForm((current) => ({ ...current, industrySelect: event.target.value }))}
                >
                  <option value="">Select industry category...</option>
                  {state.industryOptions.map((option) => (
                    <option key={`industry-category-${option}`} value={option}>{option}</option>
                  ))}
                </select>
                <input
                  className="h-11 rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                  placeholder="Or enter new industry category"
                  value={state.industryEtfForm.industryNew}
                  onChange={(event) => state.setIndustryEtfForm((current) => ({ ...current, industryNew: event.target.value }))}
                />
                <button
                  className="rounded-2xl bg-accent px-4 py-2 text-sm font-medium text-slate-950 transition hover:brightness-110"
                  onClick={() => void state.addIndustryEtf()}
                  type="button"
                >
                  Add Industry ETF
                </button>
              </div>
            </div>
          </div>
        </AdminCard>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,0.9fr),minmax(0,1.1fr)]">
        <AdminCard title={`Sector ETFs (${state.sectorEtfs.length})`} description="Broad sector funds used in the dashboard ETF universe.">
          {state.loading ? (
            <div className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" />Loading ETF lists...</div>
          ) : state.sectorEtfs.length === 0 ? (
            <EmptyState title="No sector ETFs yet" description="Add a sector ETF to establish the top-level ETF universe." />
          ) : (
            <div className="space-y-2">
              {state.sectorEtfs.map((row) => (
                <div key={`sector-${row.ticker}`} className="flex items-center justify-between rounded-2xl border border-borderSoft/70 bg-panelSoft/35 px-4 py-3">
                  <div>
                    <div className="text-sm font-semibold text-accent">{row.ticker}</div>
                    <div className="text-xs text-slate-400">{row.fundName ?? "Unnamed ETF"} {row.parentSector ? `| ${row.parentSector}` : ""}</div>
                  </div>
                  <button
                    className="rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-100 transition hover:bg-rose-500/20"
                    onClick={() => setDeleteIntent({ listType: "sector", ticker: row.ticker, label: row.ticker })}
                    type="button"
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          )}
        </AdminCard>

        <AdminCard title={`Industry ETFs (${state.industryEtfs.length})`} description="Industry and thematic funds grouped by parent sector and industry category.">
          {state.loading ? (
            <div className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" />Loading ETF lists...</div>
          ) : state.industryEtfs.length === 0 ? (
            <EmptyState title="No industry ETFs yet" description="Add an industry ETF to begin categorising the tracked universe." />
          ) : (
            <div className="space-y-2">
              {state.industryEtfs.map((row) => (
                <div key={`industry-${row.ticker}-${row.industry ?? "general"}`} className="flex items-center justify-between rounded-2xl border border-borderSoft/70 bg-panelSoft/35 px-4 py-3">
                  <div>
                    <div className="text-sm font-semibold text-accent">{row.ticker}</div>
                    <div className="text-xs text-slate-400">
                      {row.fundName ?? "Unnamed ETF"}
                      {row.parentSector ? ` | ${row.parentSector}` : ""}
                      {row.industry ? ` / ${row.industry}` : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      className="rounded-xl border border-borderSoft/80 bg-panelSoft/65 px-3 py-2 text-xs text-slate-100 transition hover:bg-panelSoft"
                      onClick={() => state.editIndustryEtf(row)}
                      type="button"
                    >
                      <span className="inline-flex items-center gap-2"><Pencil className="h-3.5 w-3.5" />Edit</span>
                    </button>
                    <button
                      className="rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-100 transition hover:bg-rose-500/20"
                      onClick={() => setDeleteIntent({ listType: "industry", ticker: row.ticker, label: `${row.ticker}${row.industry ? ` (${row.industry})` : ""}` })}
                      type="button"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </AdminCard>
      </div>

      <AdminCard title="ETF Sync Status" description="Track last sync times, source information, and any stale or failing ETF jobs.">
        {syncWarnings.length > 0 ? (
          <InlineAlert tone="warning" title="Some ETF syncs need attention">
            {syncWarnings.length} ETF {syncWarnings.length === 1 ? "entry is" : "entries are"} stale, pending, or reporting an error.
          </InlineAlert>
        ) : null}

        {state.etfSyncStatus.length === 0 ? (
          <EmptyState title="No ETF sync rows available" description="Sync status will appear here once the worker has processed tracked ETFs." />
        ) : (
          <div className="overflow-hidden rounded-2xl border border-borderSoft/70">
            <table className="min-w-full text-sm">
              <thead className="bg-panelSoft/45 text-left text-slate-400">
                <tr>
                  <th className="px-4 py-3 font-medium">Ticker</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Source</th>
                  <th className="px-4 py-3 font-medium">Records</th>
                  <th className="px-4 py-3 font-medium">Last synced</th>
                  <th className="px-4 py-3 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody>
                {state.etfSyncStatus.map((row) => (
                  <tr key={`sync-${row.etfTicker}`} className="border-t border-borderSoft/60">
                    <td className="px-4 py-3 font-semibold text-accent">{row.etfTicker}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-full border px-2 py-1 text-[11px] uppercase tracking-[0.16em] ${
                        statusTone(row.status, row.error) === "danger"
                          ? "border-rose-400/30 bg-rose-500/10 text-rose-100"
                          : statusTone(row.status, row.error) === "warning"
                            ? "border-amber-400/30 bg-amber-500/10 text-amber-100"
                            : statusTone(row.status, row.error) === "success"
                              ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-100"
                              : "border-sky-400/30 bg-sky-500/10 text-sky-100"
                      }`}>
                        {row.status ?? "unknown"}
                      </span>
                      {row.error ? <div className="mt-1 text-xs text-rose-200">{row.error}</div> : null}
                    </td>
                    <td className="px-4 py-3 text-slate-300">{row.source ?? "-"}</td>
                    <td className="px-4 py-3 text-slate-300">{row.recordsCount}</td>
                    <td className="px-4 py-3 text-slate-300">{state.formatDateTimeCompact(row.lastSyncedAt)}</td>
                    <td className="px-4 py-3 text-slate-300">{state.formatDateTimeCompact(row.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AdminCard>

      <ConfirmDialog
        open={Boolean(deleteIntent)}
        title="Delete ETF?"
        description={deleteIntent ? `Remove ${deleteIntent.label} from the tracked ${deleteIntent.listType} ETF list?` : ""}
        confirmLabel="Delete ETF"
        tone="danger"
        busy={deleteBusy}
        onCancel={() => setDeleteIntent(null)}
        onConfirm={handleDelete}
      />

      {state.editingIndustryTicker ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm" onClick={() => state.cancelIndustryEdit()}>
          <div className="admin-surface w-full max-w-2xl px-5 py-5" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-2">
                <h3 className="text-lg font-semibold text-text">Edit Industry ETF</h3>
                <p className="text-sm text-slate-400">
                  Update the fund name, parent sector, and industry bucket for {state.editingIndustryTicker}. Saving here updates the shared industry ETF master list used across overview and sectors.
                </p>
              </div>
              <button
                data-modal-close="true"
                className="rounded-xl border border-borderSoft/70 p-2 text-slate-300 transition hover:bg-panelSoft/70"
                onClick={() => state.cancelIndustryEdit()}
                type="button"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <label className="text-xs text-slate-300">
                Ticker
                <input
                  className="mt-2 h-11 w-full rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text disabled:cursor-not-allowed disabled:opacity-60"
                  value={state.industryEtfForm.ticker}
                  disabled
                />
              </label>
              <label className="text-xs text-slate-300">
                Fund name
                <input
                  className="mt-2 h-11 w-full rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                  value={state.industryEtfForm.fundName}
                  onChange={(event) => state.setIndustryEtfForm((current) => ({ ...current, fundName: event.target.value }))}
                  placeholder="Fund name"
                />
              </label>
              <label className="text-xs text-slate-300">
                Parent sector
                <select
                  className="mt-2 h-11 w-full rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                  value={state.industryEtfForm.parentSectorSelect}
                  onChange={(event) => state.setIndustryEtfForm((current) => ({ ...current, parentSectorSelect: event.target.value }))}
                >
                  <option value="">Select parent sector...</option>
                  {state.parentSectorOptions.map((option) => (
                    <option key={`edit-industry-parent-${option}`} value={option}>{option}</option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-slate-300">
                New parent sector override
                <input
                  className="mt-2 h-11 w-full rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                  value={state.industryEtfForm.parentSectorNew}
                  onChange={(event) => state.setIndustryEtfForm((current) => ({ ...current, parentSectorNew: event.target.value }))}
                  placeholder="Or enter new parent sector"
                />
              </label>
              <label className="text-xs text-slate-300">
                Industry category
                <select
                  className="mt-2 h-11 w-full rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                  value={state.industryEtfForm.industrySelect}
                  onChange={(event) => state.setIndustryEtfForm((current) => ({ ...current, industrySelect: event.target.value }))}
                >
                  <option value="">Select industry category...</option>
                  {state.industryOptions.map((option) => (
                    <option key={`edit-industry-category-${option}`} value={option}>{option}</option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-slate-300">
                New industry override
                <input
                  className="mt-2 h-11 w-full rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                  value={state.industryEtfForm.industryNew}
                  onChange={(event) => state.setIndustryEtfForm((current) => ({ ...current, industryNew: event.target.value }))}
                  placeholder="Or enter new industry category"
                />
              </label>
            </div>

            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                data-modal-close="true"
                className="rounded-xl border border-borderSoft/80 bg-panelSoft/65 px-4 py-2 text-sm text-slate-200 transition hover:bg-panelSoft"
                onClick={() => state.cancelIndustryEdit()}
                type="button"
              >
                Cancel
              </button>
              <button
                className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-slate-950 transition hover:brightness-110"
                onClick={() => void state.addIndustryEtf()}
                type="button"
              >
                Save Industry ETF
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
