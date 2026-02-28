"use client";

import { useEffect, useMemo, useState } from "react";

type Props = {
  asOfDate: string | null;
  lastUpdated: string | null;
  timezone: string;
  autoRefreshLabel: string;
  providerLabel: string;
};

const TZ_OPTIONS = [
  { label: "Melbourne", value: "Australia/Melbourne" },
  { label: "Sydney", value: "Australia/Sydney" },
  { label: "New York", value: "America/New_York" },
  { label: "Singapore", value: "Asia/Singapore" },
];

const STORAGE_KEY = "market_command_timezone";

function formatInZone(value: string | null, zone: string): string {
  if (!value) return "N/A";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: zone,
  }).format(d);
}

function asOfToIso(asOfDate: string | null): string | null {
  if (!asOfDate) return null;
  return `${asOfDate}T00:00:00Z`;
}

export function StatusBar({ asOfDate, lastUpdated, timezone, autoRefreshLabel, providerLabel }: Props) {
  const [selectedTz, setSelectedTz] = useState("Australia/Melbourne");

  useEffect(() => {
    const persisted = window.localStorage.getItem(STORAGE_KEY);
    setSelectedTz(persisted || timezone || "Australia/Melbourne");
  }, [timezone]);

  const lastUpdatedLabel = useMemo(() => formatInZone(lastUpdated, selectedTz), [lastUpdated, selectedTz]);
  const asOfLabel = useMemo(() => formatInZone(asOfToIso(asOfDate), selectedTz), [asOfDate, selectedTz]);

  return (
    <div className="card mb-4 flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
      <span className="rounded-xl bg-slate-800/70 px-2 py-1">
        Last updated: <b>{lastUpdatedLabel}</b>
      </span>
      <span className="rounded-xl bg-slate-800/50 px-2 py-1 text-slate-300">As-of: {asOfLabel}</span>
      <span className="rounded-xl bg-slate-800/50 px-2 py-1 text-slate-300">Auto-refresh: {autoRefreshLabel}</span>
      <label className="rounded-xl bg-slate-800/50 px-2 py-1 text-slate-300">
        TZ:
        <select
          className="ml-2 bg-transparent text-slate-100 outline-none"
          value={selectedTz}
          onChange={(e) => {
            const next = e.target.value;
            setSelectedTz(next);
            window.localStorage.setItem(STORAGE_KEY, next);
          }}
        >
          {TZ_OPTIONS.map((tz) => (
            <option key={tz.value} value={tz.value} className="bg-slate-900">
              {tz.label}
            </option>
          ))}
        </select>
      </label>
      <span className="rounded-xl bg-accent/15 px-2 py-1 text-accent">Source: {providerLabel}</span>
    </div>
  );
}
