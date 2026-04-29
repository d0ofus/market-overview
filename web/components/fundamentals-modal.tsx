"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import {
  getTickerFundamentals,
  refreshTickerFundamentals,
  type FundamentalsResponse,
} from "@/lib/api";
import { FundamentalsChartPanel, formatFundamentalDate } from "./fundamentals-chart-panel";

export function FundamentalsModal({
  ticker,
  onClose,
}: {
  ticker: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<FundamentalsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await getTickerFundamentals(ticker, 8);
      setData(response);
    } catch (loadError) {
      setData(null);
      setError(loadError instanceof Error ? loadError.message : "Failed to load fundamentals.");
    } finally {
      setLoading(false);
    }
  }, [ticker]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const issuerName = data?.issuer?.companyName ?? data?.rows[0]?.companyName ?? null;

  const onRefresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      await refreshTickerFundamentals(ticker);
      await load();
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Failed to refresh SEC fundamentals.");
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/70 p-4" onClick={onClose}>
      <div
        className="flex h-[calc(100vh-2rem)] w-full max-w-[96vw] flex-col overflow-hidden rounded-[30px] border border-borderSoft/75 bg-panel/95 shadow-[0_24px_80px_rgba(2,6,23,0.55)] 2xl:max-w-[92rem]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-borderSoft/60 bg-panelSoft/35 px-5 py-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Fundamentals</p>
            <h4 className="mt-1 text-base font-semibold text-slate-100">{ticker.toUpperCase()}</h4>
            {issuerName ? <div className="mt-1 text-sm text-slate-400">{issuerName}</div> : null}
            {data?.issuer?.lastRefreshedAt ? (
              <div className="mt-1 text-xs text-slate-500">SEC cache refreshed {formatFundamentalDate(data.issuer.lastRefreshedAt.slice(0, 10))}</div>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-xl border border-accent/40 bg-accent/15 px-3 py-2 text-sm font-medium text-accent transition hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={onRefresh}
              disabled={loading || refreshing}
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
              {refreshing ? "Refreshing" : "Refresh SEC"}
            </button>
            <button
              type="button"
              aria-label="Close fundamentals modal"
              data-modal-close="true"
              className="inline-flex items-center justify-center rounded-xl border border-borderSoft/70 bg-panelSoft/35 px-3 py-2 text-sm text-slate-200 transition hover:bg-panelSoft/55"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          <FundamentalsChartPanel
            data={data}
            loading={loading}
            refreshing={refreshing}
            error={error}
            onRefresh={onRefresh}
          />
        </div>
      </div>
    </div>
  );
}
