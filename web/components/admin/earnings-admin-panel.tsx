"use client";

import { AlertTriangle, Database, ListFilter, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  getAdminEarningsExclusions,
  type AdminEarningsExclusionDataset,
  type AdminEarningsExclusionsResponse,
} from "@/lib/api";
import { AdminCard } from "./admin-card";
import { AdminPageHeader } from "./admin-page-header";
import { AdminStatCard } from "./admin-stat-card";
import { EmptyState } from "./empty-state";
import { InlineAlert } from "./inline-alert";

const DATASETS: Array<{ key: AdminEarningsExclusionDataset; label: string }> = [
  { key: "surprises", label: "Surprises" },
  { key: "gaps", label: "Gap-Ups" },
];

const PAGE_SIZE = 100;

function formatCount(value: number | null | undefined): string {
  return new Intl.NumberFormat("en-US").format(Number(value ?? 0));
}

function formatMetric(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "-";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(parsed));
}

export function EarningsAdminPanel() {
  const [dataset, setDataset] = useState<AdminEarningsExclusionDataset>("surprises");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<AdminEarningsExclusionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async (nextDataset = dataset, nextOffset = offset) => {
    setLoading(true);
    setError(null);
    try {
      const response = await getAdminEarningsExclusions({ dataset: nextDataset, limit: PAGE_SIZE, offset: nextOffset });
      setData(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load earnings exclusions.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(dataset, offset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset, offset]);

  const pageStart = data && data.total > 0 ? data.offset + 1 : 0;
  const pageEnd = data ? Math.min(data.offset + data.rows.length, data.total) : 0;
  const canPrev = offset > 0 && !loading;
  const canNext = data ? offset + PAGE_SIZE < data.total && !loading : false;
  const activeDatasetLabel = useMemo(() => DATASETS.find((item) => item.key === dataset)?.label ?? "Surprises", [dataset]);

  const switchDataset = (nextDataset: AdminEarningsExclusionDataset) => {
    setDataset(nextDataset);
    setOffset(0);
  };

  return (
    <div className="space-y-6">
      <AdminPageHeader
        eyebrow="Earnings"
        title="Scanner Universe And Exclusions"
        description="Audit the active listed-equity rules behind the earnings scanner and review rows hidden from the public results."
        actions={(
          <button
            className="inline-flex h-10 items-center gap-2 rounded border border-borderSoft/80 bg-panel px-3 text-sm text-slate-200 transition hover:bg-panelSoft disabled:cursor-not-allowed disabled:opacity-50"
            disabled={loading}
            onClick={() => void load(dataset, offset)}
            type="button"
          >
            <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            Refresh
          </button>
        )}
      />

      {error ? <InlineAlert tone="danger" title="Could not load exclusions">{error}</InlineAlert> : null}
      {data?.warning ? <InlineAlert tone="warning" title="Schema warning">{data.warning}</InlineAlert> : null}

      <div className="grid gap-4 md:grid-cols-4">
        <AdminStatCard label="Excluded Rows" value={formatCount(data?.total)} helper={activeDatasetLabel} tone={data?.total ? "warning" : "success"} />
        <AdminStatCard label="Catalog Active" value={data?.catalog?.activeCount == null ? "-" : formatCount(data.catalog.activeCount)} helper={data?.catalog?.sourceKey ?? "Nasdaq Trader"} />
        <AdminStatCard label="Catalog Status" value={data?.catalog?.status ?? "-"} helper={data?.catalog?.lastSyncedAt ? `Synced ${formatDateTime(data.catalog.lastSyncedAt)}` : "No sync timestamp"} />
        <AdminStatCard label="Scanner" value="TradingView" helper={data?.scanner.tradingViewMarket ?? "america"} tone="info" />
      </div>

      <AdminCard
        title="Source And Eligibility"
        description="The same rules shown here are used by the backend filters and admin exclusion reasons."
        actions={(
          <div className="inline-flex overflow-hidden rounded border border-borderSoft/80 bg-panelSoft/60">
            {DATASETS.map((item) => (
              <button
                key={item.key}
                className={`h-9 px-3 text-sm transition ${dataset === item.key ? "bg-accent text-slate-950" : "text-slate-300 hover:bg-panelSoft"}`}
                onClick={() => switchDataset(item.key)}
                type="button"
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
      >
        <div className="grid gap-5 lg:grid-cols-[0.85fr_1.15fr]">
          <div className="space-y-3 text-sm text-slate-300">
            <div className="flex items-center gap-2 text-slate-100">
              <Database className="h-4 w-4 text-accent" />
              <span className="font-semibold">Scanner source</span>
            </div>
            <dl className="grid gap-2 text-xs">
              <div className="flex justify-between gap-4 border-b border-borderSoft/50 py-2">
                <dt className="text-slate-500">Primary</dt>
                <dd className="text-right text-slate-200">{data?.scanner.primarySource ?? "-"}</dd>
              </div>
              <div className="flex justify-between gap-4 border-b border-borderSoft/50 py-2">
                <dt className="text-slate-500">Types</dt>
                <dd className="text-slate-200">{data?.scanner.tradingViewSymbolTypes.join(", ") ?? "-"}</dd>
              </div>
              <div className="flex justify-between gap-4 border-b border-borderSoft/50 py-2">
                <dt className="text-slate-500">Backups</dt>
                <dd className="text-slate-200">{data?.scanner.backupProviders.length ? data.scanner.backupProviders.join(", ") : "None"}</dd>
              </div>
              <div className="flex justify-between gap-4 py-2">
                <dt className="text-slate-500">Exchange policy</dt>
                <dd className="max-w-sm text-right text-slate-200">{data?.scanner.defaultExchangePolicy ?? "-"}</dd>
              </div>
            </dl>
          </div>
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-slate-100">
              <ShieldCheck className="h-4 w-4 text-accent" />
              <span className="font-semibold">Active rules</span>
            </div>
            <ul className="grid gap-2 text-sm text-slate-300 md:grid-cols-2">
              {(data?.rules ?? []).map((rule) => (
                <li key={rule} className="rounded border border-borderSoft/60 bg-panelSoft/45 px-3 py-2">{rule}</li>
              ))}
            </ul>
          </div>
        </div>
      </AdminCard>

      <AdminCard
        title={`${activeDatasetLabel} Excluded Rows`}
        description="Rows remain stored in D1 but are hidden from normal earnings results, facets, status counts, and exports."
        actions={(
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <ListFilter className="h-4 w-4" />
            {pageStart}-{pageEnd} of {formatCount(data?.total)}
          </div>
        )}
      >
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-400">
            <RefreshCw className="h-4 w-4 animate-spin" />
            Loading exclusions...
          </div>
        ) : data && data.rows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[64rem] text-left text-sm">
              <thead className="border-b border-borderSoft/70 text-xs uppercase tracking-[0.16em] text-slate-500">
                <tr>
                  <th className="px-3 py-2">Ticker</th>
                  <th className="px-3 py-2">Company</th>
                  <th className="px-3 py-2">Exchange</th>
                  <th className="px-3 py-2">Report</th>
                  <th className="px-3 py-2">Metric</th>
                  <th className="px-3 py-2">Reasons</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-borderSoft/60">
                {data.rows.map((row) => (
                  <tr key={row.id} className="hover:bg-panelSoft/35">
                    <td className="px-3 py-2 font-semibold text-slate-100">{row.ticker}<div className="text-xs font-normal text-slate-500">{row.sourceSymbol}</div></td>
                    <td className="max-w-sm px-3 py-2 text-slate-300">{row.companyName ?? "-"}</td>
                    <td className="px-3 py-2 text-slate-300">{row.exchange ?? "-"}</td>
                    <td className="px-3 py-2 text-slate-300">{row.reportDate || "-"}</td>
                    <td className="px-3 py-2 text-slate-300">{row.metricLabel}: <span className="text-slate-100">{formatMetric(row.metricValue)}</span></td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1.5">
                        {row.reasons.map((reason) => (
                          <span key={reason} className="inline-flex items-center gap-1 rounded border border-amber-400/20 bg-amber-500/10 px-2 py-1 text-xs text-amber-100">
                            <AlertTriangle className="h-3 w-3" />
                            {reason}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No exclusions found" description="No stored rows are currently being hidden by the earnings eligibility rules for this dataset." />
        )}
        <div className="mt-4 flex items-center justify-between gap-3">
          <button
            className="inline-flex h-9 items-center rounded border border-borderSoft/80 bg-panel px-3 text-sm text-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!canPrev}
            onClick={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))}
            type="button"
          >
            Previous
          </button>
          <button
            className="inline-flex h-9 items-center rounded border border-borderSoft/80 bg-panel px-3 text-sm text-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!canNext}
            onClick={() => setOffset((current) => current + PAGE_SIZE)}
            type="button"
          >
            Next
          </button>
        </div>
      </AdminCard>
    </div>
  );
}
