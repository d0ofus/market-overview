"use client";

import type { ResearchTickerResult } from "@/lib/api";

type Props = {
  results: ResearchTickerResult[];
  onOpenTicker: (result: ResearchTickerResult) => void;
};

function fmtScore(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(1) : "-";
}

export function ResearchResultsTable({ results, onOpenTicker }: Props) {
  return (
    <div className="card p-3">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-200">Ranked Research Results</h3>
        <span className="text-[11px] text-slate-500">{results.length} tickers</span>
      </div>
      <div className="max-h-[32rem] overflow-auto">
        <table className="min-w-full text-xs">
          <thead className="bg-slate-900/60">
            <tr>
              {["Rank", "Ticker", "Score", "Confidence", "Priced In", "Setup", "Peers", "Valuation"].map((label) => (
                <th key={label} className="px-2 py-1.5 text-left text-slate-300">{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {results.map((row) => (
              <tr
                key={row.snapshotId}
                className="cursor-pointer border-t border-borderSoft/60 hover:bg-slate-900/30"
                onClick={() => onOpenTicker(row)}
              >
                <td className="px-2 py-2 text-slate-300">{row.attentionRank ?? "-"}</td>
                <td className="px-2 py-2">
                  <div className="font-semibold text-accent">{row.ticker}</div>
                  <div className="text-[11px] text-slate-500">{row.companyName ?? "-"}</div>
                </td>
                <td className="px-2 py-2 text-slate-300">{fmtScore(row.overallScore)}</td>
                <td className="px-2 py-2 text-slate-300">{row.confidenceLabel ?? "-"}</td>
                <td className="px-2 py-2 text-slate-300">{row.pricedInAssessmentLabel ?? "-"}</td>
                <td className="px-2 py-2 text-slate-300">{row.setupQualityLabel ?? "-"}</td>
                <td className="px-2 py-2 text-slate-300">
                  {row.peerComparisonAvailable ? `available (${row.peerComparisonConfidence ?? "?"})` : "unavailable"}
                </td>
                <td className="px-2 py-2 text-slate-300">{row.valuationLabel ?? "-"}</td>
              </tr>
            ))}
            {results.length === 0 && (
              <tr>
                <td colSpan={8} className="px-2 py-4 text-center text-slate-400">No completed research results yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
