"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Loader2 } from "lucide-react";
import type { CorrelationPairResponse } from "@/lib/api";

type DrilldownTab = "overview" | "spread" | "dynamics";

const dateFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "2-digit",
  year: "numeric",
  timeZone: "UTC",
});

function formatDate(value: string | null | undefined): string {
  if (!value) return "-";
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return dateFmt.format(parsed);
}

function formatCorrelation(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  return value.toFixed(2);
}

function formatNumber(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "-";
  return value.toFixed(digits);
}

function formatSignedPercent(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "-";
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(digits)}%`;
}

function tooltipNumber(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return value.toFixed(2);
}

function WarningList({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="rounded-xl border border-yellow-700/40 bg-yellow-900/15 p-3 text-sm text-yellow-100">
      <div className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-yellow-200">Pair Warnings</div>
      <ul className="space-y-1">
        {warnings.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
    </div>
  );
}

export function CorrelationPairDrilldown({
  pairData,
  pairLoading,
  pairError,
  activeTab,
  onTabChange,
  selectedLabel,
}: {
  pairData: CorrelationPairResponse | null;
  pairLoading: boolean;
  pairError: string | null;
  activeTab: DrilldownTab;
  onTabChange: (tab: DrilldownTab) => void;
  selectedLabel: string | null;
}) {
  const pairStats = pairData?.overview.stats ?? null;
  const leadLagBest = pairData?.dynamics.leadLag.bestLag ?? null;

  return (
    <div className="card overflow-hidden">
      <div className="border-b border-borderSoft/70 px-4 py-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h3 className="text-lg font-semibold">Pair Drilldown</h3>
            <p className="mt-1 text-sm text-slate-400">
              {selectedLabel ?? "Select a valid pair from the matrix to load the drilldown charts."}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {([
              { key: "overview", label: "Overview" },
              { key: "spread", label: "Spread" },
              { key: "dynamics", label: "Dynamics" },
            ] as Array<{ key: DrilldownTab; label: string }>).map((tab) => (
              <button
                key={tab.key}
                className={`rounded-lg px-3 py-1.5 text-sm ${activeTab === tab.key ? "bg-accent/20 text-accent" : "bg-slate-800 text-slate-300"}`}
                onClick={() => onTabChange(tab.key)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="p-4">
        {pairLoading && !pairData && (
          <div className="mb-4 flex items-center gap-2 text-sm text-slate-300">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading pair analysis...
          </div>
        )}
        {pairError && <div className="mb-4 text-sm text-rose-300">{pairError}</div>}
        {!pairLoading && !pairError && !pairData && (
          <p className="text-sm text-slate-400">Select a non-diagonal matrix cell to load a pair drilldown.</p>
        )}

        {pairData && (
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-xl border border-borderSoft/70 bg-panelSoft/30 p-3">
                <div className="text-xs uppercase tracking-[0.08em] text-slate-400">Overlap Range</div>
                <div className="mt-1 text-sm font-semibold text-slate-100">
                  {formatDate(pairData.pair.overlapStartDate)} to {formatDate(pairData.pair.overlapEndDate)}
                </div>
                <div className="mt-1 text-xs text-slate-400">
                  {pairData.pair.priceObservationCount} price points / {pairData.pair.returnObservationCount} return points
                </div>
              </div>
              <div className="rounded-xl border border-borderSoft/70 bg-panelSoft/30 p-3">
                <div className="text-xs uppercase tracking-[0.08em] text-slate-400">R / R^2</div>
                <div className="mt-1 text-sm font-semibold text-slate-100">
                  {formatCorrelation(pairStats?.correlation)} / {pairStats?.rSquared != null ? pairStats.rSquared.toFixed(2) : "-"}
                </div>
              </div>
              <div className="rounded-xl border border-borderSoft/70 bg-panelSoft/30 p-3">
                <div className="text-xs uppercase tracking-[0.08em] text-slate-400">Beta / Intercept</div>
                <div className="mt-1 text-sm font-semibold text-slate-100">
                  {formatNumber(pairStats?.beta, 4)} / {formatNumber(pairStats?.intercept, 4)}
                </div>
              </div>
              <div className="rounded-xl border border-borderSoft/70 bg-panelSoft/30 p-3">
                <div className="text-xs uppercase tracking-[0.08em] text-slate-400">Best Lead-Lag</div>
                <div className="mt-1 text-sm font-semibold text-slate-100">
                  {leadLagBest ? `${leadLagBest.lag > 0 ? "+" : ""}${leadLagBest.lag}D (${leadLagBest.correlation.toFixed(2)})` : "-"}
                </div>
              </div>
            </div>

            <WarningList warnings={pairData.warnings} />

            {activeTab === "overview" && (
              <div className="grid gap-4 xl:grid-cols-2">
                <div className="card p-4">
                  <div className="mb-3">
                    <h4 className="text-sm font-semibold text-slate-100">Normalized Price Comparison</h4>
                    <p className="text-xs text-slate-400">Both series rebased to 100 on the first shared date.</p>
                  </div>
                  <div className="h-80">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={pairData.overview.normalizedSeries} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.12)" />
                        <XAxis dataKey="date" tickFormatter={(value) => String(value).slice(2)} minTickGap={28} stroke="#94a3b8" />
                        <YAxis stroke="#94a3b8" />
                        <Tooltip
                          contentStyle={{ background: "#020617", border: "1px solid rgba(148,163,184,0.18)" }}
                          labelFormatter={(value) => formatDate(String(value))}
                          formatter={(value, name) => [tooltipNumber(value), name]}
                        />
                        <Legend />
                        <Line type="monotone" dataKey="left" name={pairData.pair.left.ticker} stroke="#38bdf8" dot={false} strokeWidth={2} />
                        <Line type="monotone" dataKey="right" name={pairData.pair.right.ticker} stroke="#f97316" dot={false} strokeWidth={2} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="card p-4">
                  <div className="mb-3">
                    <h4 className="text-sm font-semibold text-slate-100">Regression Scatter</h4>
                    <p className="text-xs text-slate-400">OLS on aligned daily log closes.</p>
                  </div>
                  <div className="h-80">
                    <ResponsiveContainer width="100%" height="100%">
                      <ScatterChart margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.12)" />
                        <XAxis type="number" dataKey="x" stroke="#94a3b8" tickFormatter={(value) => Number(value).toFixed(2)} />
                        <YAxis type="number" dataKey="y" stroke="#94a3b8" tickFormatter={(value) => Number(value).toFixed(2)} />
                        <Tooltip
                          cursor={{ strokeDasharray: "3 3" }}
                          contentStyle={{ background: "#020617", border: "1px solid rgba(148,163,184,0.18)" }}
                          formatter={(value, name) => [tooltipNumber(value), name]}
                          labelFormatter={(_, payload) => formatDate(payload?.[0]?.payload?.date)}
                        />
                        <Scatter data={pairData.overview.regressionPoints} fill="#38bdf8" fillOpacity={0.65} />
                        {pairData.overview.regressionLine.length === 2 && (
                          <ReferenceLine segment={pairData.overview.regressionLine} stroke="#f97316" strokeWidth={2} />
                        )}
                      </ScatterChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>
            )}

            {activeTab === "spread" && (
              <div className="grid gap-4 xl:grid-cols-2">
                <div className="card p-4">
                  <div className="mb-3">
                    <h4 className="text-sm font-semibold text-slate-100">Spread With Rolling Bands</h4>
                    <p className="text-xs text-slate-400">Regression residual spread with rolling mean and +/-2 sigma bands.</p>
                  </div>
                  <div className="h-80">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={pairData.spread.series} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.12)" />
                        <XAxis dataKey="date" tickFormatter={(value) => String(value).slice(2)} minTickGap={28} stroke="#94a3b8" />
                        <YAxis stroke="#94a3b8" tickFormatter={(value) => Number(value).toFixed(2)} />
                        <Tooltip
                          contentStyle={{ background: "#020617", border: "1px solid rgba(148,163,184,0.18)" }}
                          labelFormatter={(value) => formatDate(String(value))}
                          formatter={(value, name) => [tooltipNumber(value), name]}
                        />
                        <Legend />
                        <Line type="monotone" dataKey="spread" name="Spread" stroke="#38bdf8" dot={false} strokeWidth={2} />
                        <Line type="monotone" dataKey="mean" name="Rolling Mean" stroke="#f8fafc" dot={false} strokeDasharray="4 4" />
                        <Line type="monotone" dataKey="upper2Sigma" name="+2 sigma" stroke="#f97316" dot={false} strokeDasharray="4 4" />
                        <Line type="monotone" dataKey="lower2Sigma" name="-2 sigma" stroke="#22c55e" dot={false} strokeDasharray="4 4" />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="card p-4">
                  <div className="mb-3">
                    <h4 className="text-sm font-semibold text-slate-100">Z-Score</h4>
                    <p className="text-xs text-slate-400">Spread normalized by rolling mean and rolling standard deviation.</p>
                  </div>
                  <div className="h-80">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={pairData.spread.series} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.12)" />
                        <XAxis dataKey="date" tickFormatter={(value) => String(value).slice(2)} minTickGap={28} stroke="#94a3b8" />
                        <YAxis stroke="#94a3b8" />
                        <Tooltip
                          contentStyle={{ background: "#020617", border: "1px solid rgba(148,163,184,0.18)" }}
                          labelFormatter={(value) => formatDate(String(value))}
                          formatter={(value) => [tooltipNumber(value), "Z-Score"]}
                        />
                        <ReferenceLine y={0} stroke="rgba(148,163,184,0.6)" />
                        <ReferenceLine y={2} stroke="rgba(249,115,22,0.6)" strokeDasharray="4 4" />
                        <ReferenceLine y={-2} stroke="rgba(34,197,94,0.6)" strokeDasharray="4 4" />
                        <Line type="monotone" dataKey="zScore" name="Z-Score" stroke="#a78bfa" dot={false} strokeWidth={2} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>
            )}

            {activeTab === "dynamics" && (
              <div className="space-y-4">
                <div className="grid gap-4 xl:grid-cols-2">
                  <div className="card p-4">
                    <div className="mb-3">
                      <h4 className="text-sm font-semibold text-slate-100">Rolling Correlation</h4>
                      <p className="text-xs text-slate-400">Rolling Pearson correlation on aligned daily returns.</p>
                    </div>
                    <div className="h-80">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={pairData.dynamics.rollingCorrelation} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.12)" />
                          <XAxis dataKey="date" tickFormatter={(value) => String(value).slice(2)} minTickGap={28} stroke="#94a3b8" />
                          <YAxis domain={[-1, 1]} stroke="#94a3b8" />
                          <Tooltip
                            contentStyle={{ background: "#020617", border: "1px solid rgba(148,163,184,0.18)" }}
                            labelFormatter={(value) => formatDate(String(value))}
                            formatter={(value) => [formatCorrelation(typeof value === "number" ? value : null), "Rolling r"]}
                          />
                          <ReferenceLine y={0} stroke="rgba(148,163,184,0.6)" />
                          <Line type="monotone" dataKey="value" name="Rolling r" stroke="#facc15" dot={false} strokeWidth={2} connectNulls={false} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  <div className="card p-4">
                    <div className="mb-3">
                      <h4 className="text-sm font-semibold text-slate-100">Lead-Lag Scan</h4>
                      <p className="text-xs text-slate-400">Cross-correlation over offsets from -20D to +20D.</p>
                    </div>
                    <div className="h-80">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={pairData.dynamics.leadLag.rows} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.12)" />
                          <XAxis dataKey="lag" stroke="#94a3b8" />
                          <YAxis domain={[-1, 1]} stroke="#94a3b8" />
                          <Tooltip
                            contentStyle={{ background: "#020617", border: "1px solid rgba(148,163,184,0.18)" }}
                            formatter={(value, name, payload) => {
                              if (name === "correlation") {
                                const row = payload?.payload as { observationCount?: number } | undefined;
                                return [`${formatCorrelation(typeof value === "number" ? value : null)} (n=${row?.observationCount ?? 0})`, "Correlation"];
                              }
                              return [tooltipNumber(value), name];
                            }}
                          />
                          <ReferenceLine y={0} stroke="rgba(148,163,184,0.6)" />
                          {pairData.dynamics.leadLag.confidenceBand != null && (
                            <>
                              <ReferenceLine y={pairData.dynamics.leadLag.confidenceBand} stroke="rgba(250,204,21,0.6)" strokeDasharray="4 4" />
                              <ReferenceLine y={-pairData.dynamics.leadLag.confidenceBand} stroke="rgba(250,204,21,0.6)" strokeDasharray="4 4" />
                            </>
                          )}
                          <Bar dataKey="correlation" name="correlation">
                            {pairData.dynamics.leadLag.rows.map((row) => {
                              const isBest = pairData.dynamics.leadLag.bestLag?.lag === row.lag;
                              const fill = row.correlation == null
                                ? "#475569"
                                : isBest
                                  ? "#facc15"
                                  : row.correlation >= 0
                                    ? "#38bdf8"
                                    : "#f87171";
                              return <Cell key={`lag-${row.lag}`} fill={fill} />;
                            })}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </div>

                <div className="card p-4">
                  <div className="mb-3">
                    <h4 className="text-sm font-semibold text-slate-100">Lag-Applied Return Overlay</h4>
                    <p className="text-xs text-slate-400">
                      {leadLagBest
                        ? `Best lag ${leadLagBest.lag > 0 ? "+" : ""}${leadLagBest.lag}D. Positive lag means ${pairData.pair.left.ticker} leads ${pairData.pair.right.ticker}.`
                        : "No statistically usable lag was available for the current overlap."}
                    </p>
                  </div>
                  <div className="h-80">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={pairData.dynamics.lagOverlay} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.12)" />
                        <XAxis dataKey="date" tickFormatter={(value) => String(value).slice(2)} minTickGap={28} stroke="#94a3b8" />
                        <YAxis stroke="#94a3b8" tickFormatter={(value) => `${(Number(value) * 100).toFixed(1)}%`} />
                        <Tooltip
                          contentStyle={{ background: "#020617", border: "1px solid rgba(148,163,184,0.18)" }}
                          labelFormatter={(value) => formatDate(String(value))}
                          formatter={(value, name) => [formatSignedPercent(typeof value === "number" ? value : null), name]}
                        />
                        <Legend />
                        <Line type="monotone" dataKey="left" name={pairData.pair.left.ticker} stroke="#38bdf8" dot={false} strokeWidth={2} connectNulls={false} />
                        <Line type="monotone" dataKey="right" name={pairData.pair.right.ticker} stroke="#f97316" dot={false} strokeWidth={2} connectNulls={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
