"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { refreshPageData } from "@/lib/api";

type Props = {
  page: "overview" | "breadth" | "sectors" | "thirteenf" | "admin" | "ticker" | "tools" | "alerts" | "scanning" | "watchlist-compiler" | "gappers";
  ticker?: string | null;
  className?: string;
};

export function ManualRefreshButton({ page, ticker = null, className = "" }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [label, setLabel] = useState<string | null>(null);

  return (
    <div className={className}>
      <button
        className="inline-flex items-center gap-2 rounded-xl border border-accent/40 bg-accent/15 px-3 py-2 text-sm font-medium text-accent disabled:opacity-60"
        disabled={loading}
        onClick={async () => {
          setLoading(true);
          try {
            const res = await refreshPageData(page, ticker);
            setLabel(res.notes ?? `Refreshed ${res.refreshedTickers} ticker${res.refreshedTickers === 1 ? "" : "s"}`);
            router.refresh();
          } catch (error) {
            setLabel(error instanceof Error ? error.message : "Refresh failed");
          } finally {
            setLoading(false);
            setTimeout(() => setLabel(null), 3500);
          }
        }}
      >
        <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        {loading ? "Refreshing..." : "Update This Page"}
      </button>
      {label && <p className="mt-1 text-xs text-slate-400">{label}</p>}
    </div>
  );
}
