"use client";

import { useEffect, useMemo, useState } from "react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { FedFundsComparisonSeries, FedFundsPathRow, FedWatchResponse } from "@/lib/api";

const DECISION_TZ = "America/New_York";
const DECISION_HOUR = 14;
const DECISION_MINUTE = 0;

type ChartPoint = {
  label: string;
  meetingIso: string;
  current: number | null;
  ago_1w: number | null;
  ago_3w: number | null;
  ago_6w: number | null;
  ago_10w: number | null;
};

function ratePct(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "N/A";
  return `${value.toFixed(digits)}%`;
}

function signedBps(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "N/A";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)} bps`;
}

function formatMeetingDate(iso: string | null | undefined, fallback: string): string {
  if (!iso) return fallback;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return fallback;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

function formatGeneratedAt(value: string | null | undefined): string {
  if (!value) return "Unavailable";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(parsed);
}

function nextMeetingPricing(row: FedFundsPathRow | null): { headline: string; detail: string } {
  if (!row) return { headline: "Unavailable", detail: "No meeting data" };
  if (row.probMovePct <= 0) return { headline: "0% NO CHANGE", detail: signedBps(row.changeBps) };
  const action = row.probIsCut ? "CUT" : "HIKE";
  return { headline: `${Math.round(row.probMovePct)}% ${action}`, detail: signedBps(row.changeBps) };
}

function numMovesLabel(row: FedFundsPathRow): string {
  const absMoves = Math.abs(row.numMoves);
  const value = absMoves.toFixed(2);
  return row.numMovesIsCut ? `(${value})` : value;
}

function probabilityLabel(row: FedFundsPathRow): string {
  const value = `${row.probMovePct.toFixed(1)}%`;
  if (row.probMovePct <= 0) return value;
  return row.probIsCut ? `(${value})` : value;
}

function directionClass(value: number): string {
  if (value > 0) return "text-emerald-500 dark:text-emerald-400";
  if (value < 0) return "text-rose-500 dark:text-rose-400";
  return "text-slate-500 dark:text-slate-300";
}

function zonedTimeToUtc(isoDate: string, hour: number, minute: number, timeZone: string): Date {
  const desired = `${isoDate}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
  const utcGuess = new Date(`${desired}Z`);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(utcGuess);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  const asUtc = Date.UTC(
    Number(get("year")),
    Number(get("month")) - 1,
    Number(get("day")),
    Number(get("hour")),
    Number(get("minute")),
    Number(get("second")),
  );
  const desiredUtc = Date.UTC(
    Number(isoDate.slice(0, 4)),
    Number(isoDate.slice(5, 7)) - 1,
    Number(isoDate.slice(8, 10)),
    hour,
    minute,
    0,
  );
  return new Date(utcGuess.getTime() + (desiredUtc - asUtc));
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return "00d 00:00:00";
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${days}d ${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function meetingDecisionLabel(iso: string | null | undefined, fallback: string): string {
  if (!iso) return fallback;
  const decision = zonedTimeToUtc(iso, DECISION_HOUR, DECISION_MINUTE, DECISION_TZ);
  return `${formatMeetingDate(iso, fallback)} | ${new Intl.DateTimeFormat("en-US", {
    timeZone: DECISION_TZ,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(decision)}`;
}

function buildChartData(
  currentMidpoint: number | null,
  currentRows: FedFundsPathRow[],
  comparisons: FedFundsComparisonSeries[],
): ChartPoint[] {
  const seriesMaps = new Map<FedFundsComparisonSeries["key"], Map<string, number>>();
  for (const series of comparisons) {
    seriesMaps.set(series.key, new Map(series.rows.map((row) => [row.meetingIso, row.implied])));
  }

  return [
    {
      label: "Current",
      meetingIso: "current",
      current: currentMidpoint,
      ago_1w: comparisons.find((series) => series.key === "ago_1w")?.effr ?? null,
      ago_3w: comparisons.find((series) => series.key === "ago_3w")?.effr ?? null,
      ago_6w: comparisons.find((series) => series.key === "ago_6w")?.effr ?? null,
      ago_10w: comparisons.find((series) => series.key === "ago_10w")?.effr ?? null,
    },
    ...currentRows.map((row) => ({
      label: row.meeting,
      meetingIso: row.meetingIso,
      current: row.impliedRatePostMeeting,
      ago_1w: seriesMaps.get("ago_1w")?.get(row.meetingIso) ?? null,
      ago_3w: seriesMaps.get("ago_3w")?.get(row.meetingIso) ?? null,
      ago_6w: seriesMaps.get("ago_6w")?.get(row.meetingIso) ?? null,
      ago_10w: seriesMaps.get("ago_10w")?.get(row.meetingIso) ?? null,
    })),
  ];
}

export function FedFundsRatePanel({ snapshot }: { snapshot: FedWatchResponse }) {
  const rows = snapshot.data?.rows ?? [];
  const nextMeeting = rows[0] ?? null;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const countdown = useMemo(() => {
    if (!nextMeeting?.meetingIso) return "--";
    const when = zonedTimeToUtc(nextMeeting.meetingIso, DECISION_HOUR, DECISION_MINUTE, DECISION_TZ);
    return formatCountdown(when.getTime() - now);
  }, [nextMeeting, now]);

  const nextPricing = useMemo(() => nextMeetingPricing(nextMeeting), [nextMeeting]);
  const chartData = useMemo(
    () => buildChartData(snapshot.data?.midpoint ?? null, rows, snapshot.data?.comparisons ?? []),
    [rows, snapshot.data?.comparisons, snapshot.data?.midpoint],
  );

  const comparisonMeta = snapshot.data?.comparisons ?? [];
  const comparisonLines = comparisonMeta.map((series) => ({
    key: series.key,
    label: series.label,
    color:
      series.key === "ago_1w" ? "#F4C84A"
      : series.key === "ago_3w" ? "#CBD5E1"
      : series.key === "ago_6w" ? "#94A3B8"
      : "#64748B",
  }));

  const warningTone =
    snapshot.status === "stale"
      ? "border-amber-400/30 bg-amber-500/10 text-amber-100"
      : "border-red-400/30 bg-red-500/10 text-red-100";

  return (
    <section className="card overflow-hidden">
      <div className="border-b border-borderSoft/70 px-5 py-4">
        <div className="space-y-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.22em] text-accent">Macro Rates</div>
            <h2 className="text-xl font-semibold text-text">Federal Reserve</h2>
            <p className="text-sm text-slate-400">Fed Funds Rate: Twelve-Month Market Pricing</p>
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-slate-300">
            <span>As of: <span className="font-medium text-text">{snapshot.data?.asOf ?? "Unavailable"}</span></span>
            <span>Target Band: <span className="font-medium text-text">{snapshot.data?.currentBand ?? "Unavailable"}</span></span>
            <span>Midpoint: <span className="font-medium text-text">{ratePct(snapshot.data?.midpoint, 3)}</span></span>
            <span>Last EFFR: <span className="font-medium text-text">{ratePct(snapshot.data?.mostRecentEffr, 2)}</span></span>
            <span>Step: <span className="font-medium text-text">{snapshot.data?.assumedMoveBps ?? "N/A"} bps</span></span>
            <span>
              Source:{" "}
              <a
                className="text-accent hover:underline"
                href={snapshot.data?.sourceUrl ?? "https://rateprobability.com/fed"}
                target="_blank"
                rel="noreferrer"
              >
                RateProbability
              </a>
            </span>
            <span>Snapshot: <span className="font-medium text-text">{formatGeneratedAt(snapshot.data?.generatedAt)}</span></span>
          </div>
        </div>
      </div>

      {snapshot.warning && (
        <div className={`mx-5 mt-4 rounded-2xl border px-4 py-3 text-sm ${warningTone}`}>
          {snapshot.warning}
        </div>
      )}

      {!snapshot.data && (
        <div className="px-5 py-8">
          <div className="rounded-2xl border border-borderSoft/70 bg-panelSoft/70 p-5">
            <div className="text-sm font-semibold text-text">Fed funds pricing unavailable</div>
            <p className="mt-2 text-sm text-slate-400">
              The RateProbability API could not be reached from this environment. When it recovers, this section will automatically show the cached or live rate path again.
            </p>
            <a
              className="mt-4 inline-flex rounded-xl bg-accent/20 px-3 py-2 text-sm font-medium text-accent hover:bg-accent/30"
              href="https://rateprobability.com/fed"
              target="_blank"
              rel="noreferrer"
            >
              Open RateProbability
            </a>
          </div>
        </div>
      )}

      {snapshot.data && (
        <div className="space-y-5 px-5 py-5">
          <div className="grid gap-3 xl:grid-cols-3">
            <div className="rounded-2xl border border-accent/20 bg-panelSoft/80 p-4">
              <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Next Decision In</div>
              <div className="mt-2 font-mono text-3xl font-semibold tracking-[0.04em] text-text">{countdown}</div>
              <div className="mt-3 text-sm text-slate-400">{meetingDecisionLabel(nextMeeting?.meetingIso, nextMeeting?.meeting ?? "--")}</div>
            </div>
            <div className="rounded-2xl border border-emerald-400/20 bg-panelSoft/80 p-4">
              <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Next Meeting Pricing</div>
              <div className="mt-2 text-3xl font-semibold text-emerald-500 dark:text-emerald-400">{nextPricing.headline}</div>
              <div className="mt-3 text-base text-emerald-600 dark:text-emerald-300">{nextPricing.detail}</div>
            </div>
            <div className="rounded-2xl border border-borderSoft/70 bg-panelSoft/80 p-4">
              <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Current Rate</div>
              <div className="mt-2 text-3xl font-semibold text-text">{ratePct(snapshot.data.midpoint, 2)}</div>
              <div className="mt-3 text-sm text-slate-400">Last EFFR: {ratePct(snapshot.data.mostRecentEffr, 3)}</div>
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-[1.15fr_0.92fr]">
            <div className="rounded-3xl border border-borderSoft/70 bg-panelSoft/75 p-5">
              <div className="mb-4 text-lg font-semibold text-text">Path of Fed Funds Target Midpoint: Market Expectation</div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-panel/80">
                    <tr>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-300">Meeting</th>
                      <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-300">Implied Rate (Post-Meeting)</th>
                      <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-300">Probability of Hike(Cut)</th>
                      <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-300"># of Hikes(Cuts)</th>
                      <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-300">Delta vs Current (bps)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.meetingIso} className="border-t border-borderSoft/60">
                        <td className="px-3 py-3 font-medium text-text">{row.meeting}</td>
                        <td className="px-3 py-3 text-right font-mono text-slate-200">{ratePct(row.impliedRatePostMeeting, 2)}</td>
                        <td className={`px-3 py-3 text-right font-mono ${directionClass(row.probIsCut ? -row.probMovePct : row.probMovePct)}`}>
                          {probabilityLabel(row)}
                        </td>
                        <td className={`px-3 py-3 text-right font-mono ${directionClass(row.numMovesIsCut ? -row.numMoves : row.numMoves)}`}>
                          {numMovesLabel(row)}
                        </td>
                        <td className={`px-3 py-3 text-right font-mono ${directionClass(row.changeBps)}`}>{signedBps(row.changeBps)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-4 text-xs text-slate-500">
                Estimates represent market expectations for the midpoint of the Fed&apos;s target band for the fed funds rate. Data updates multiple times daily and the page shows the last cached copy if the live fetch is unavailable.
              </p>
            </div>

            <div className="rounded-3xl border border-borderSoft/70 bg-panelSoft/75 p-5">
              <div className="mb-4 text-lg font-semibold text-text">Implied Rate Path</div>
              <div className="h-[420px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 16 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.18)" />
                    <XAxis
                      dataKey="label"
                      tick={{ fill: "#94A3B8", fontSize: 11 }}
                      angle={-32}
                      textAnchor="end"
                      height={72}
                      interval={0}
                    />
                    <YAxis
                      tick={{ fill: "#94A3B8", fontSize: 11 }}
                      tickFormatter={(value) => `${Number(value).toFixed(2)}%`}
                      domain={["dataMin - 0.05", "dataMax + 0.05"]}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "rgba(2, 6, 23, 0.96)",
                        border: "1px solid rgba(71, 85, 105, 0.8)",
                        borderRadius: 16,
                      }}
                      labelStyle={{ color: "#E2E8F0" }}
                      formatter={(value, name) => [`${Number(value).toFixed(3)}%`, String(name)]}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Line
                      type="monotone"
                      dataKey="current"
                      name="Current"
                      stroke="#3B82F6"
                      strokeWidth={2.5}
                      dot={{ r: 3 }}
                      activeDot={{ r: 5 }}
                      connectNulls
                    />
                    {comparisonLines.map((series) => (
                      <Line
                        key={series.key}
                        type="monotone"
                        dataKey={series.key}
                        name={series.label}
                        stroke={series.color}
                        strokeWidth={2}
                        dot={{ r: 2.5 }}
                        activeDot={{ r: 4 }}
                        connectNulls
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
