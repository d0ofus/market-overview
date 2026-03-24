"use client";

import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { FedWatchMeeting, FedWatchResponse } from "@/lib/api";

function formatDateLabel(value: string | null, fallback: string): string {
  if (!value) return fallback;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return fallback;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(parsed);
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

function pct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "N/A";
  return `${value.toFixed(1)}%`;
}

function dominantOutcome(meeting: FedWatchMeeting | null): string {
  if (!meeting?.probabilities?.length) return "Unavailable";
  const top = [...meeting.probabilities].sort((left, right) => right.nowPct - left.nowPct)[0];
  return top ? `${top.targetRange} (${pct(top.nowPct)})` : "Unavailable";
}

function midpointLabel(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "Unavailable";
  return `${value.toFixed(1)} bps`;
}

function biasLabel(meeting: FedWatchMeeting | null): string {
  if (!meeting) return "Unavailable";
  const hike = meeting.hikeProbability ?? 0;
  const cut = meeting.cutProbability ?? 0;
  const unchanged = meeting.noChangeProbability ?? 0;
  if (unchanged >= hike && unchanged >= cut) return `No change bias (${pct(unchanged)})`;
  if (hike >= cut) return `Hike bias (${pct(hike)})`;
  return `Cut bias (${pct(cut)})`;
}

function probabilityTooltipLabel(key: "nowPct" | "dayAgoPct" | "weekAgoPct" | "monthAgoPct"): string {
  if (key === "dayAgoPct") return "1 Day";
  if (key === "weekAgoPct") return "1 Week";
  if (key === "monthAgoPct") return "1 Month";
  return "Now";
}

export function FedFundsRatePanel({ snapshot }: { snapshot: FedWatchResponse }) {
  const meetings = snapshot.data?.meetings ?? [];
  const [selectedMeetingIndex, setSelectedMeetingIndex] = useState(0);
  const selectedMeeting = meetings[selectedMeetingIndex] ?? meetings[0] ?? null;

  const barData = useMemo(
    () =>
      (selectedMeeting?.probabilities ?? []).map((row) => ({
        targetRange: row.targetRange,
        nowPct: row.nowPct,
      })),
    [selectedMeeting],
  );

  const lineData = useMemo(
    () =>
      meetings.map((meeting) => ({
        label: meeting.label,
        expectedMidpointBps: meeting.expectedMidpointBps,
      })),
    [meetings],
  );

  const probabilityColumns = useMemo(() => {
    const columns: Array<{ key: "nowPct" | "dayAgoPct" | "weekAgoPct" | "monthAgoPct"; label: string }> = [
      { key: "nowPct", label: "Now" },
    ];
    if ((selectedMeeting?.probabilities ?? []).some((row) => row.dayAgoPct != null)) columns.push({ key: "dayAgoPct", label: "1 Day" });
    if ((selectedMeeting?.probabilities ?? []).some((row) => row.weekAgoPct != null)) columns.push({ key: "weekAgoPct", label: "1 Week" });
    if ((selectedMeeting?.probabilities ?? []).some((row) => row.monthAgoPct != null)) columns.push({ key: "monthAgoPct", label: "1 Month" });
    return columns;
  }, [selectedMeeting]);

  const warningTone = snapshot.status === "stale" ? "border-amber-400/30 bg-amber-500/10 text-amber-100" : "border-red-400/30 bg-red-500/10 text-red-100";

  return (
    <section className="card overflow-hidden">
      <div className="border-b border-borderSoft/70 px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="text-xs font-semibold uppercase tracking-[0.22em] text-accent">Macro Rates</div>
            <h2 className="text-xl font-semibold text-slate-100">Fed Funds Rate</h2>
            <p className="max-w-3xl text-sm text-slate-400">
              CME FedWatch target-rate probabilities for the meeting months exposed by the public tool.
            </p>
          </div>
          <div className="space-y-1 text-right text-xs text-slate-400">
            <div>Source: <a className="text-accent hover:underline" href={snapshot.data?.sourceUrl ?? "https://www.cmegroup.com/markets/interest-rates/cme-fedwatch-tool.html"} target="_blank" rel="noreferrer">CME FedWatch</a></div>
            <div>Snapshot: {formatGeneratedAt(snapshot.data?.generatedAt)}</div>
            <div>Current target range: <span className="font-medium text-slate-200">{snapshot.data?.currentTargetRange ?? "Unavailable"}</span></div>
          </div>
        </div>
      </div>

      {snapshot.warning && (
        <div className={`mx-5 mt-4 rounded-2xl border px-4 py-3 text-sm ${warningTone}`}>
          {snapshot.warning}
        </div>
      )}

      {!selectedMeeting && (
        <div className="px-5 py-8">
          <div className="rounded-2xl border border-borderSoft/70 bg-slate-900/30 p-5">
            <div className="text-sm font-semibold text-slate-100">FedWatch data unavailable</div>
            <p className="mt-2 text-sm text-slate-400">
              The public CME FedWatch site did not expose parseable meeting probabilities from this environment. The section is live and will automatically render once a successful snapshot is captured.
            </p>
            <a
              className="mt-4 inline-flex rounded-xl bg-accent/20 px-3 py-2 text-sm font-medium text-accent hover:bg-accent/30"
              href="https://www.cmegroup.com/markets/interest-rates/cme-fedwatch-tool.html"
              target="_blank"
              rel="noreferrer"
            >
              Open CME FedWatch
            </a>
          </div>
        </div>
      )}

      {selectedMeeting && (
        <div className="space-y-5 px-5 py-5">
          <div className="flex flex-wrap gap-2">
            {meetings.map((meeting, index) => (
              <button
                key={`${meeting.label}-${index}`}
                className={`rounded-xl border px-3 py-2 text-sm transition ${
                  index === selectedMeetingIndex
                    ? "border-accent/50 bg-accent/15 text-accent"
                    : "border-borderSoft/70 bg-slate-900/30 text-slate-300 hover:border-accent/30 hover:text-slate-100"
                }`}
                onClick={() => setSelectedMeetingIndex(index)}
                type="button"
              >
                {meeting.label}
              </button>
            ))}
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-2xl border border-borderSoft/70 bg-slate-900/30 p-4">
              <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Next Meeting</div>
              <div className="mt-2 text-lg font-semibold text-slate-100">{formatDateLabel(selectedMeeting.meetingDate, selectedMeeting.label)}</div>
              <div className="mt-1 text-xs text-slate-500">{selectedMeeting.contract ?? "Contract unavailable"}</div>
            </div>
            <div className="rounded-2xl border border-borderSoft/70 bg-slate-900/30 p-4">
              <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Dominant Outcome</div>
              <div className="mt-2 text-lg font-semibold text-slate-100">{dominantOutcome(selectedMeeting)}</div>
              <div className="mt-1 text-xs text-slate-500">Most probable target range right now</div>
            </div>
            <div className="rounded-2xl border border-borderSoft/70 bg-slate-900/30 p-4">
              <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Bias</div>
              <div className="mt-2 text-lg font-semibold text-slate-100">{biasLabel(selectedMeeting)}</div>
              <div className="mt-1 text-xs text-slate-500">Compared with the current target range</div>
            </div>
            <div className="rounded-2xl border border-borderSoft/70 bg-slate-900/30 p-4">
              <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Expected Midpoint</div>
              <div className="mt-2 text-lg font-semibold text-slate-100">{midpointLabel(selectedMeeting.expectedMidpointBps)}</div>
              <div className="mt-1 text-xs text-slate-500">Probability-weighted target midpoint</div>
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
            <div className="rounded-2xl border border-borderSoft/70 bg-slate-900/30 p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-slate-100">Target Rate Probability Distribution</div>
                  <div className="text-xs text-slate-400">{selectedMeeting.label} meeting</div>
                </div>
                <div className="text-xs text-slate-500">Bars sized by current implied probability</div>
              </div>
              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={barData} margin={{ top: 8, right: 8, left: -12, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.16)" />
                    <XAxis dataKey="targetRange" tick={{ fill: "#94A3B8", fontSize: 11 }} />
                    <YAxis tick={{ fill: "#94A3B8", fontSize: 11 }} tickFormatter={(value) => `${value}%`} />
                    <Tooltip
                      formatter={(value) => [`${Number(value).toFixed(1)}%`, "Probability"]}
                      contentStyle={{ background: "rgba(2, 6, 23, 0.96)", border: "1px solid rgba(71, 85, 105, 0.8)", borderRadius: 16 }}
                      labelStyle={{ color: "#E2E8F0" }}
                    />
                    <Bar dataKey="nowPct" fill="#38BDF8" radius={[10, 10, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="rounded-2xl border border-borderSoft/70 bg-slate-900/30 p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-slate-100">Cross-Meeting Path</div>
                  <div className="text-xs text-slate-400">Expected midpoint across exposed meetings</div>
                </div>
              </div>
              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={lineData} margin={{ top: 8, right: 8, left: -16, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.16)" />
                    <XAxis dataKey="label" tick={{ fill: "#94A3B8", fontSize: 11 }} />
                    <YAxis tick={{ fill: "#94A3B8", fontSize: 11 }} domain={["dataMin - 12.5", "dataMax + 12.5"]} />
                    <Tooltip
                      formatter={(value) => [`${Number(value).toFixed(1)} bps`, "Expected midpoint"]}
                      contentStyle={{ background: "rgba(2, 6, 23, 0.96)", border: "1px solid rgba(71, 85, 105, 0.8)", borderRadius: 16 }}
                      labelStyle={{ color: "#E2E8F0" }}
                    />
                    <Line type="monotone" dataKey="expectedMidpointBps" stroke="#34D399" strokeWidth={2.5} dot={{ r: 3 }} activeDot={{ r: 5 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-borderSoft/70 bg-slate-900/30 p-4">
            <div className="mb-3 text-sm font-semibold text-slate-100">Probability Table</div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-900/60">
                  <tr>
                    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-300">Target Range</th>
                    {probabilityColumns.map((column) => (
                      <th key={column.key} className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-300">
                        {column.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {selectedMeeting.probabilities.map((row) => (
                    <tr key={row.targetRange} className="border-t border-borderSoft/60">
                      <td className="px-3 py-2 font-medium text-slate-200">{row.targetRange}</td>
                      {probabilityColumns.map((column) => (
                        <td key={column.key} className="px-3 py-2 text-slate-300">
                          {pct(row[column.key])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-4 grid gap-2 text-xs text-slate-500 md:grid-cols-3">
              <div>Mid price: <span className="text-slate-300">{selectedMeeting.midPrice ?? "N/A"}</span></div>
              <div>Prior volume: <span className="text-slate-300">{selectedMeeting.priorVolume?.toLocaleString("en-US") ?? "N/A"}</span></div>
              <div>Prior OI: <span className="text-slate-300">{selectedMeeting.priorOi?.toLocaleString("en-US") ?? "N/A"}</span></div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
