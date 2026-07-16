"use client";

import { useCallback, useState } from "react";
import { ExternalLink, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import {
  createPerplexityBrowserbaseVerificationSession,
  getPerplexityFinanceNotableMovement,
  type AlertNewsRow,
  type PerplexityFinanceNotableMovementLookup,
} from "@/lib/api";

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const date = new Intl.DateTimeFormat("en-US", { month: "short", day: "2-digit" }).format(parsed);
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(parsed);
  const time = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit" }).format(parsed);
  return `${date}, ${weekday}, ${time}`;
}

export function MultiChartMetricBubble({
  label,
  value,
  valueClass = "text-slate-100",
  className = "",
}: {
  label: string;
  value: string;
  valueClass?: string;
  className?: string;
}) {
  return (
    <span className={`inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-borderSoft/60 bg-panelSoft/30 px-3 py-1.5 text-xs text-slate-200 ${className}`}>
      <span className="shrink-0 uppercase tracking-[0.12em] text-slate-500">{label}</span>
      <span className={`min-w-0 max-w-[12rem] truncate font-semibold ${valueClass}`} title={value}>
        {value}
      </span>
    </span>
  );
}

export function MultiChartNewsList({
  items,
  expanded,
  onToggle,
  compact = false,
}: {
  items: AlertNewsRow[];
  expanded: Set<string>;
  onToggle: (key: string) => void;
  compact?: boolean;
}) {
  if (items.length === 0) {
    return <p className="text-xs text-slate-400">No news found for this ticker/day.</p>;
  }

  return (
    <div className="space-y-2">
      {items.slice(0, 3).map((item, idx) => {
        const expandKey = `${item.ticker}-${item.tradingDay}-${idx}`;
        const isOpen = expanded.has(expandKey);
        return (
          <article key={expandKey} className="rounded border border-borderSoft/60 bg-panelSoft/25 p-2">
            <a href={item.url} target="_blank" rel="noreferrer" className="text-sm font-medium text-accent hover:underline">
              {item.headline}
            </a>
            <div className="mt-1 text-[11px] text-slate-400">
              {item.source} {item.publishedAt ? `• ${formatDateTime(item.publishedAt)}` : ""}
            </div>
            <button
              type="button"
              className="mt-1 text-[11px] text-slate-300 underline decoration-dotted"
              onClick={() => onToggle(expandKey)}
            >
              {isOpen ? "Hide details" : "Show details"}
            </button>
            {isOpen ? (
              <div className="mt-1 text-xs leading-relaxed text-slate-300">
                {item.snippet ?? "No summary available from provider."}
              </div>
            ) : null}
            {!compact ? (
              <div className="mt-1 break-all text-[11px] text-slate-500">
                <a href={item.url} target="_blank" rel="noreferrer" className="hover:text-slate-300">
                  {item.url}
                </a>
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

export type MovementCardState = {
  open: boolean;
  loading: boolean;
  data: PerplexityFinanceNotableMovementLookup | null;
  error: string | null;
  verifying?: boolean;
  verificationError?: string | null;
  verificationUrl?: string | null;
};

function movementStatusClass(status: PerplexityFinanceNotableMovementLookup["status"] | "loading" | "empty"): string {
  if (status === "ready") return "border-pos/40 bg-pos/10 text-pos";
  if (status === "blocked" || status === "parse_error") return "border-red-500/40 bg-red-900/20 text-red-200";
  if (status === "pending_timeout") return "border-yellow-600/50 bg-yellow-900/20 text-yellow-200";
  return "border-borderSoft/70 bg-panelSoft/35 text-slate-300";
}

export function MultiChartMovementExpansion({
  ticker,
  state,
  onRefresh,
  onVerify,
}: {
  ticker: string;
  state: MovementCardState;
  onRefresh: () => void;
  onVerify: () => void;
}) {
  const data = state.data;
  const status = state.loading && !data ? "loading" : data?.status ?? "empty";
  const sourceUrl = data?.url ?? `https://www.perplexity.ai/finance/${encodeURIComponent(ticker)}`;
  const canVerify = data?.status === "blocked" && data.diagnostics.provider === "browserbase";

  return (
    <div className="mt-4 rounded-[18px] border border-borderSoft/60 bg-panelSoft/25 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-slate-100">Notable Price Movement</h4>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
            <span className={`rounded-full border px-2 py-0.5 font-medium ${movementStatusClass(status)}`}>
              {status === "loading" ? "loading" : status}
            </span>
            {data?.fetchedAt ? <span>Fetched {formatDateTime(data.fetchedAt)}</span> : null}
            {data?.diagnostics?.bodyState ? <span>Body {data.diagnostics.bodyState}</span> : null}
          </div>
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-xl border border-borderSoft/70 bg-panelSoft/35 px-3 py-2 text-xs text-slate-200 transition hover:bg-panelSoft/55 disabled:cursor-not-allowed disabled:opacity-60"
          onClick={onRefresh}
          disabled={state.loading}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${state.loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>
      {canVerify ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded border border-accent/40 bg-accent/15 px-2.5 py-1.5 text-accent transition hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-60"
            onClick={onVerify}
            disabled={state.verifying}
          >
            {state.verifying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
            Verify session
          </button>
          {state.verificationUrl ? (
            <a
              href={state.verificationUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded border border-borderSoft px-2.5 py-1.5 text-slate-300 transition hover:border-accent/40 hover:text-accent"
            >
              Live View <ExternalLink className="h-3 w-3" />
            </a>
          ) : null}
        </div>
      ) : null}
      {state.loading && !data ? (
        <div className="mt-3 flex items-center gap-2 text-xs text-slate-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading visible Perplexity text...
        </div>
      ) : null}
      {state.verificationError ? (
        <div className="mt-3 rounded border border-red-500/40 bg-red-900/20 px-3 py-2 text-xs text-red-200">{state.verificationError}</div>
      ) : null}
      {state.error ? (
        <div className="mt-3 rounded border border-red-500/40 bg-red-900/20 px-3 py-2 text-xs text-red-200">{state.error}</div>
      ) : null}
      {data?.warning ? (
        <div className="mt-3 rounded border border-yellow-700/50 bg-yellow-900/20 px-3 py-2 text-xs text-yellow-200">{data.warning}</div>
      ) : null}
      {data?.notablePriceMovement ? (
        <p className="mt-3 text-sm leading-relaxed text-slate-200">{data.notablePriceMovement}</p>
      ) : data && !state.loading && !state.error ? (
        <p className="mt-3 text-sm leading-relaxed text-slate-400">No visible Notable Price Movement paragraph was found.</p>
      ) : null}
      <div className="mt-3 break-all text-[11px] text-slate-500">
        <a href={sourceUrl} target="_blank" rel="noreferrer" className="hover:text-slate-300">{sourceUrl}</a>
      </div>
    </div>
  );
}

export function useMultiChartMovement() {
  const [movementByKey, setMovementByKey] = useState<Record<string, MovementCardState>>({});

  const loadMovement = useCallback(async (key: string, ticker: string, refresh = false) => {
    setMovementByKey((current) => {
      const existing = current[key];
      return {
        ...current,
        [key]: {
          open: true,
          loading: true,
          data: existing?.data ?? null,
          error: null,
          verifying: existing?.verifying ?? false,
          verificationError: null,
          verificationUrl: existing?.verificationUrl ?? null,
        },
      };
    });
    try {
      const response = await getPerplexityFinanceNotableMovement(ticker, { refresh });
      setMovementByKey((current) => ({
        ...current,
        [key]: {
          open: true,
          loading: false,
          data: response,
          error: null,
          verifying: current[key]?.verifying ?? false,
          verificationError: null,
          verificationUrl: current[key]?.verificationUrl ?? null,
        },
      }));
    } catch (error) {
      setMovementByKey((current) => {
        const existing = current[key];
        return {
          ...current,
          [key]: {
            open: true,
            loading: false,
            data: existing?.data ?? null,
            error: error instanceof Error ? error.message : "Failed to load notable price movement.",
            verifying: existing?.verifying ?? false,
            verificationError: existing?.verificationError ?? null,
            verificationUrl: existing?.verificationUrl ?? null,
          },
        };
      });
    }
  }, []);

  const openMovementVerification = useCallback(async (key: string, ticker: string) => {
    setMovementByKey((current) => {
      const existing = current[key];
      return existing ? { ...current, [key]: { ...existing, verifying: true, verificationError: null } } : current;
    });
    try {
      const session = await createPerplexityBrowserbaseVerificationSession({
        targetUrl: `https://www.perplexity.ai/finance/${encodeURIComponent(ticker)}`,
      });
      const verificationUrl = session.debuggerFullscreenUrl || session.debuggerUrl;
      setMovementByKey((current) => {
        const existing = current[key];
        return existing ? { ...current, [key]: { ...existing, verifying: false, verificationError: null, verificationUrl } } : current;
      });
      window.open(verificationUrl, "_blank", "noopener,noreferrer");
    } catch (error) {
      setMovementByKey((current) => {
        const existing = current[key];
        return existing
          ? { ...current, [key]: { ...existing, verifying: false, verificationError: error instanceof Error ? error.message : "Failed to create Browserbase verification session." } }
          : current;
      });
    }
  }, []);

  const toggleMovement = useCallback((key: string, ticker: string) => {
    const existing = movementByKey[key];
    if (existing?.open) {
      setMovementByKey((current) => ({ ...current, [key]: { ...existing, open: false } }));
      return;
    }
    if (existing?.data || existing?.loading) {
      setMovementByKey((current) => ({ ...current, [key]: { ...existing, open: true } }));
      return;
    }
    void loadMovement(key, ticker);
  }, [loadMovement, movementByKey]);

  return { movementByKey, loadMovement, openMovementVerification, toggleMovement };
}
