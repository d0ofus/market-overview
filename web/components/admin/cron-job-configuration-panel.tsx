"use client";

import { useEffect, useMemo, useState } from "react";
import {
  updateAdminCronJob,
  type AdminCronJob,
  type AdminCronJobField,
  type AdminCronJobsResponse,
} from "@/lib/api";
import { AdminCard } from "./admin-card";
import { InlineAlert } from "./inline-alert";

type Props = {
  data: AdminCronJobsResponse | null;
  onUpdated: (data: AdminCronJobsResponse) => void;
};

type CronValue = AdminCronJob["values"][string];
type CronValues = AdminCronJob["values"];
type WatchlistSetMeta = {
  id: string;
  label: string;
  enabled: boolean;
  localTime: string;
  timezone: string;
  latestRunAt: string | null;
};

const weekdayOptions = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function valueString(value: CronValue, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function valueNumber(value: CronValue, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function valueBoolean(value: CronValue, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") return ["true", "1", "yes", "on"].includes(value.toLowerCase());
  return fallback;
}

function valueDays(value: CronValue): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function watchlistSets(job: AdminCronJob | null): WatchlistSetMeta[] {
  const raw = job?.meta?.watchlistSets;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => item && typeof item === "object" ? item as Partial<WatchlistSetMeta> : null)
    .filter((item): item is Partial<WatchlistSetMeta> => Boolean(item?.id && item?.label))
    .map((item) => ({
      id: String(item.id),
      label: String(item.label),
      enabled: Boolean(item.enabled),
      localTime: String(item.localTime ?? "08:15"),
      timezone: String(item.timezone ?? "Australia/Sydney"),
      latestRunAt: item.latestRunAt ? String(item.latestRunAt) : null,
    }));
}

function selectedSetValues(job: AdminCronJob, setId: string): CronValues | null {
  const set = watchlistSets(job).find((item) => item.id === setId);
  if (!set) return null;
  return {
    setId: set.id,
    enabled: set.enabled,
    localTime: set.localTime,
    timezone: set.timezone,
  };
}

function renderField(
  field: AdminCronJobField,
  job: AdminCronJob,
  values: CronValues,
  setValues: (updater: (current: CronValues) => CronValues) => void,
) {
  const commonLabel = <span className="text-xs font-medium text-slate-300">{field.label}</span>;

  if (field.type === "boolean") {
    const active = valueBoolean(values[field.key]);
    return (
      <button
        key={field.key}
        className={`h-11 rounded-2xl border px-4 text-left text-sm transition ${
          active
            ? "border-accent/50 bg-accent/15 text-accent"
            : "border-borderSoft/80 bg-panel text-slate-300 hover:bg-panelSoft"
        }`}
        onClick={() => setValues((current) => ({ ...current, [field.key]: !active }))}
        type="button"
      >
        {field.label}: {active ? "Enabled" : "Disabled"}
      </button>
    );
  }

  if (field.type === "number") {
    return (
      <label key={field.key} className="block">
        {commonLabel}
        <input
          className="mt-2 h-11 w-full rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
          min={field.min}
          max={field.max}
          step={field.step}
          type="number"
          value={valueNumber(values[field.key], field.min ?? 0)}
          onChange={(event) => setValues((current) => ({ ...current, [field.key]: Number(event.target.value) }))}
        />
      </label>
    );
  }

  if (field.type === "time") {
    return (
      <label key={field.key} className="block">
        {commonLabel}
        <input
          className="mt-2 h-11 w-full rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
          type="time"
          value={valueString(values[field.key], "08:15")}
          onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
        />
      </label>
    );
  }

  if (field.type === "timezone" || field.type === "select") {
    return (
      <label key={field.key} className="block">
        {commonLabel}
        <select
          className="mt-2 h-11 w-full rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
          value={valueString(values[field.key])}
          onChange={(event) => {
            const nextValue = event.target.value;
            if (job.key === "watchlist-compiler" && field.key === "setId") {
              const nextSetValues = selectedSetValues(job, nextValue);
              setValues((current) => ({ ...current, ...(nextSetValues ?? { setId: nextValue }) }));
              return;
            }
            setValues((current) => ({ ...current, [field.key]: nextValue }));
          }}
        >
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  const activeDays = new Set(valueDays(values[field.key]));
  return (
    <div key={field.key} className="text-xs text-slate-300">
      {field.label}
      <div className="mt-2 flex flex-wrap gap-2">
        {weekdayOptions.map((day) => {
          const active = activeDays.has(day);
          return (
            <button
              key={day}
              className={`rounded-full border px-3 py-1.5 text-xs transition ${
                active
                  ? "border-accent/60 bg-accent/15 text-accent"
                  : "border-borderSoft/80 bg-panel text-slate-300 hover:bg-panelSoft"
              }`}
              onClick={() => setValues((current) => {
                const days = new Set(valueDays(current[field.key]));
                if (days.has(day)) days.delete(day);
                else days.add(day);
                return { ...current, [field.key]: Array.from(days) };
              })}
              type="button"
            >
              {day.slice(0, 3)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function CronJobConfigurationPanel({ data, onUpdated }: Props) {
  const [selectedKey, setSelectedKey] = useState("");
  const [values, setValues] = useState<CronValues>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger" | "info"; text: string } | null>(null);

  const jobs = data?.jobs ?? [];
  const selectedJob = useMemo(
    () => jobs.find((job) => job.key === selectedKey) ?? jobs[0] ?? null,
    [jobs, selectedKey],
  );

  useEffect(() => {
    if (!selectedJob) return;
    setSelectedKey(selectedJob.key);
    setValues(selectedJob.values);
  }, [selectedJob?.key]);

  const save = async () => {
    if (!selectedJob) return;
    setSaving(true);
    setMessage(null);
    try {
      const response = await updateAdminCronJob(selectedJob.key, values);
      onUpdated(response);
      const updatedJob = response.jobs.find((job) => job.key === selectedJob.key);
      if (updatedJob) setValues(updatedJob.values);
      setMessage({ tone: "success", text: `Saved ${selectedJob.label}.` });
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Failed to save cron job settings." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <AdminCard
      title="Cron Job Configuration"
      description="The Cloudflare heartbeat stays fixed; these settings control what each app-level scheduled job does when that heartbeat arrives."
      actions={data ? <span className="rounded-full border border-borderSoft/70 bg-panelSoft/50 px-3 py-1 text-xs text-slate-300">{data.fixedCronExpression}</span> : null}
    >
      {!data || !selectedJob ? (
        <div className="rounded-2xl border border-borderSoft/70 bg-panelSoft/45 px-4 py-3 text-sm text-slate-400">
          Loading cron job settings...
        </div>
      ) : (
        <div className="space-y-5">
          {message ? <InlineAlert tone={message.tone}>{message.text}</InlineAlert> : null}
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr),minmax(0,1.4fr)]">
            <label className="block text-xs text-slate-300">
              Scheduled job
              <select
                className="mt-2 h-11 w-full rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                value={selectedJob.key}
                onChange={(event) => {
                  const next = jobs.find((job) => job.key === event.target.value);
                  if (!next) return;
                  setSelectedKey(next.key);
                  setValues(next.values);
                  setMessage(null);
                }}
              >
                {jobs.map((job) => (
                  <option key={job.key} value={job.key}>
                    {job.category} / {job.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="rounded-2xl border border-borderSoft/70 bg-panelSoft/45 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-100">{selectedJob.label}</p>
                  <p className="mt-1 text-xs text-slate-400">{selectedJob.description}</p>
                </div>
                <span className={`rounded-full border px-3 py-1 text-xs ${valueBoolean(values.enabled) ? "border-green-400/40 bg-green-400/10 text-green-200" : "border-borderSoft/80 bg-panel text-slate-400"}`}>
                  {valueBoolean(values.enabled) ? "Enabled" : "Disabled"}
                </span>
              </div>
              <p className="mt-3 text-xs text-slate-400">
                Cadence: <span className="text-slate-200">{selectedJob.cadence}</span>
              </p>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {selectedJob.fields.map((field) => renderField(field, selectedJob, values, setValues))}
          </div>

          <div className="flex justify-end">
            <button
              className="h-11 rounded-2xl bg-accent px-4 text-sm font-medium text-slate-950 transition hover:brightness-110 disabled:opacity-60"
              disabled={saving}
              onClick={() => void save()}
              type="button"
            >
              {saving ? "Saving..." : "Save Cron Job"}
            </button>
          </div>
        </div>
      )}
    </AdminCard>
  );
}
