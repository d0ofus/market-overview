"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { Check, ChevronDown, Clock3, Database, Plus, Pencil, Trash2, X } from "lucide-react";
import {
  createOverviewFocusItem,
  deleteOverviewFocusItem,
  getOverviewFocusHistory,
  getOverviewFocusItems,
  updateOverviewFocusItem,
  type OverviewFocusHistoryItem,
  type OverviewFocusItem,
} from "@/lib/api";
import { ManualRefreshButton } from "./manual-refresh-button";

type RefreshStatus = {
  asOfDate: string | null;
  lastUpdated: string | null;
  timezone: string;
  autoRefreshLabel: string;
  providerLabel: string;
};

type Props = {
  initialItems: OverviewFocusItem[];
  initialHistory: OverviewFocusHistoryItem[];
  refreshStatus: RefreshStatus;
  configId?: string;
};

const TZ_OPTIONS = [
  { label: "Melbourne", value: "Australia/Melbourne" },
  { label: "Sydney", value: "Australia/Sydney" },
  { label: "New York", value: "America/New_York" },
  { label: "Singapore", value: "Asia/Singapore" },
];

const TIMEZONE_STORAGE_KEY = "market_command_timezone";

function normalizeClientText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeClientKey(value: string): string {
  return normalizeClientText(value).toLocaleLowerCase("en-US");
}

function formatInZone(value: string | null, zone: string): string {
  if (!value) return "N/A";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: zone,
  }).format(date);
}

function asOfToIso(asOfDate: string | null): string | null {
  if (!asOfDate) return null;
  return `${asOfDate}T00:00:00Z`;
}

function buttonClass(tone: "quiet" | "accent" | "danger" = "quiet"): string {
  if (tone === "accent") {
    return "inline-flex h-9 w-9 items-center justify-center rounded-xl border border-accent/40 bg-accent/15 text-accent transition hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-50";
  }
  if (tone === "danger") {
    return "inline-flex h-8 w-8 items-center justify-center rounded-lg border border-borderSoft/70 bg-panelSoft/35 text-slate-400 transition hover:border-danger/40 hover:bg-danger/10 hover:text-danger disabled:cursor-not-allowed disabled:opacity-50";
  }
  return "inline-flex h-8 w-8 items-center justify-center rounded-lg border border-borderSoft/70 bg-panelSoft/35 text-slate-400 transition hover:bg-panelSoft/60 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-50";
}

function OverviewRefreshMenu({ status }: { status: RefreshStatus }) {
  const [selectedTz, setSelectedTz] = useState("Australia/Melbourne");
  const [hoverOpen, setHoverOpen] = useState(false);
  const [pinnedOpen, setPinnedOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const open = hoverOpen || pinnedOpen;

  useEffect(() => {
    const persisted = window.localStorage.getItem(TIMEZONE_STORAGE_KEY);
    setSelectedTz(persisted || status.timezone || "Australia/Melbourne");
  }, [status.timezone]);

  useEffect(() => {
    if (!pinnedOpen) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setPinnedOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setPinnedOpen(false);
    };

    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [pinnedOpen]);

  const lastUpdatedLabel = useMemo(() => formatInZone(status.lastUpdated, selectedTz), [status.lastUpdated, selectedTz]);
  const asOfLabel = useMemo(() => formatInZone(asOfToIso(status.asOfDate), selectedTz), [status.asOfDate, selectedTz]);

  return (
    <div
      ref={menuRef}
      className="relative"
      onMouseEnter={() => setHoverOpen(true)}
      onMouseLeave={() => setHoverOpen(false)}
      onFocusCapture={() => setHoverOpen(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHoverOpen(false);
      }}
    >
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setPinnedOpen((current) => !current)}
        className="inline-flex items-center gap-2 rounded-xl border border-borderSoft/80 bg-panelSoft/60 px-3 py-2 text-sm font-medium text-slate-200 transition hover:border-accent/35 hover:bg-panelSoft"
      >
        <Clock3 className="h-4 w-4 text-accent" />
        <span>Data Freshness</span>
        <ChevronDown className={`h-4 w-4 text-slate-500 transition ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          role="dialog"
          className="absolute right-0 top-full z-40 mt-2 w-[min(92vw,28rem)] rounded-2xl border border-borderSoft/80 bg-panel p-3 shadow-[0_22px_54px_rgba(2,6,23,0.36)] backdrop-blur-xl"
        >
          <div className="grid gap-2 text-sm">
            <div className="rounded-xl border border-borderSoft/70 bg-panelSoft/45 px-3 py-2">
              <div className="text-[11px] uppercase tracking-[0.14em] text-slate-500">Last updated</div>
              <div className="mt-1 font-medium text-slate-100">{lastUpdatedLabel}</div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-xl border border-borderSoft/70 bg-panelSoft/35 px-3 py-2">
                <div className="text-[11px] uppercase tracking-[0.14em] text-slate-500">As-of</div>
                <div className="mt-1 text-slate-200">{asOfLabel}</div>
              </div>
              <div className="rounded-xl border border-borderSoft/70 bg-panelSoft/35 px-3 py-2">
                <div className="text-[11px] uppercase tracking-[0.14em] text-slate-500">Auto-refresh</div>
                <div className="mt-1 text-slate-200">{status.autoRefreshLabel}</div>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-center">
              <label className="rounded-xl border border-borderSoft/70 bg-panelSoft/35 px-3 py-2 text-slate-300">
                <span className="text-[11px] uppercase tracking-[0.14em] text-slate-500">Timezone</span>
                <select
                  className="mt-1 block w-full bg-transparent text-slate-100 outline-none"
                  value={selectedTz}
                  onChange={(event) => {
                    const next = event.target.value;
                    setSelectedTz(next);
                    window.localStorage.setItem(TIMEZONE_STORAGE_KEY, next);
                  }}
                >
                  {TZ_OPTIONS.map((tz) => (
                    <option key={tz.value} value={tz.value} className="bg-slate-900">
                      {tz.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="rounded-xl border border-accent/20 bg-accent/10 px-3 py-2 text-accent">
                <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.14em]">
                  <Database className="h-3.5 w-3.5" />
                  Source
                </div>
                <div className="mt-1 text-sm font-medium">{status.providerLabel}</div>
              </div>
            </div>
            <ManualRefreshButton page="overview" />
          </div>
        </div>
      )}
    </div>
  );
}

export function CurrentFocusPanel({ initialItems, initialHistory, refreshStatus, configId = "default" }: Props) {
  const [items, setItems] = useState(initialItems);
  const [history, setHistory] = useState(initialHistory);
  const [draft, setDraft] = useState("");
  const [selectedHistoryText, setSelectedHistoryText] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "info" | "danger"; text: string } | null>(null);

  const activeKeys = useMemo(() => new Set(items.map((item) => normalizeClientKey(item.text))), [items]);

  async function syncFocusData() {
    const [nextItems, nextHistory] = await Promise.all([
      getOverviewFocusItems(configId),
      getOverviewFocusHistory(configId),
    ]);
    setItems(nextItems.rows ?? []);
    setHistory(nextHistory.rows ?? []);
  }

  function showError(error: unknown, fallback: string) {
    setMessage({ tone: "danger", text: error instanceof Error ? error.message : fallback });
  }

  async function submitFocus(event: FormEvent) {
    event.preventDefault();
    const nextText = normalizeClientText(draft || selectedHistoryText);
    if (!nextText) {
      setMessage({ tone: "danger", text: "Enter or select a focus." });
      return;
    }

    setSaving(true);
    setMessage(null);
    try {
      const created = await createOverviewFocusItem(nextText, configId);
      setItems((current) => [...current, created.item].sort((left, right) => left.sortOrder - right.sortOrder));
      setDraft("");
      setSelectedHistoryText("");
      await syncFocusData();
    } catch (error) {
      showError(error, "Failed to add focus.");
    } finally {
      setSaving(false);
    }
  }

  async function saveEdit(id: string) {
    const nextText = normalizeClientText(editingText);
    if (!nextText) {
      setMessage({ tone: "danger", text: "Focus text is required." });
      return;
    }

    setBusyId(id);
    setMessage(null);
    try {
      const updated = await updateOverviewFocusItem(id, nextText);
      setItems((current) => current.map((item) => (item.id === id ? updated.item : item)));
      setEditingId(null);
      setEditingText("");
      await syncFocusData();
    } catch (error) {
      showError(error, "Failed to update focus.");
    } finally {
      setBusyId(null);
    }
  }

  async function deleteFocus(id: string) {
    setBusyId(id);
    setMessage(null);
    try {
      await deleteOverviewFocusItem(id);
      setItems((current) => current.filter((item) => item.id !== id));
      await syncFocusData();
    } catch (error) {
      showError(error, "Failed to delete focus.");
    } finally {
      setBusyId(null);
    }
  }

  function handleDraftKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setDraft("");
      setSelectedHistoryText("");
      setMessage(null);
    }
  }

  function handleEditKeyDown(event: KeyboardEvent<HTMLInputElement>, id: string) {
    if (event.key === "Enter") {
      event.preventDefault();
      void saveEdit(id);
    }
    if (event.key === "Escape") {
      setEditingId(null);
      setEditingText("");
    }
  }

  return (
    <section className="card overflow-visible p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-accent">Current Focus</div>
          <h2 className="mt-1 text-xl font-semibold leading-tight text-slate-100 md:text-2xl">
            Market Playbook
          </h2>
        </div>
        <OverviewRefreshMenu status={refreshStatus} />
      </div>

      <div className="mt-4 space-y-3">
        {items.length === 0 ? (
          <div className="rounded-xl border border-dashed border-borderSoft/80 bg-panelSoft/25 px-3 py-3 text-sm text-slate-400">
            No active focus set.
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {items.map((item) => {
              const isEditing = editingId === item.id;
              const isBusy = busyId === item.id;
              return (
                <div
                  key={item.id}
                  className="group flex min-h-11 max-w-full items-center gap-2 rounded-xl border border-borderSoft/75 bg-panelSoft/45 px-3 py-2 text-sm text-slate-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]"
                >
                  {isEditing ? (
                    <>
                      <input
                        className="min-w-[220px] flex-1 rounded-lg border border-borderSoft/80 bg-panel px-3 py-1.5 text-sm text-slate-100 outline-none transition focus:border-accent/60 focus:ring-2 focus:ring-accent/15"
                        value={editingText}
                        onChange={(event) => setEditingText(event.target.value)}
                        onKeyDown={(event) => handleEditKeyDown(event, item.id)}
                        autoFocus
                      />
                      <button
                        type="button"
                        className={buttonClass("accent")}
                        disabled={isBusy}
                        onClick={() => void saveEdit(item.id)}
                        aria-label="Save focus"
                      >
                        <Check className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        className={buttonClass()}
                        disabled={isBusy}
                        onClick={() => {
                          setEditingId(null);
                          setEditingText("");
                        }}
                        aria-label="Cancel edit"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="max-w-[68vw] overflow-hidden text-ellipsis whitespace-nowrap md:max-w-3xl">
                        {item.text}
                      </span>
                      <button
                        type="button"
                        className={buttonClass()}
                        disabled={isBusy}
                        onClick={() => {
                          setEditingId(item.id);
                          setEditingText(item.text);
                        }}
                        aria-label="Edit focus"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        className={buttonClass("danger")}
                        disabled={isBusy}
                        onClick={() => void deleteFocus(item.id)}
                        aria-label="Delete focus"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <form className="grid gap-2 md:grid-cols-[minmax(180px,260px)_1fr_auto]" onSubmit={submitFocus}>
          <select
            className="h-11 rounded-xl border border-borderSoft/80 bg-panelSoft/40 px-3 text-sm text-slate-200 outline-none transition hover:bg-panelSoft/60 focus:border-accent/60 focus:ring-2 focus:ring-accent/15 disabled:opacity-50"
            value={selectedHistoryText}
            disabled={history.length === 0 || saving}
            onChange={(event) => {
              setSelectedHistoryText(event.target.value);
              if (event.target.value) setDraft("");
            }}
          >
            <option value="" className="bg-slate-900">
              Previous focus
            </option>
            {history.map((row) => {
              const alreadyActive = activeKeys.has(normalizeClientKey(row.text));
              return (
                <option key={`${row.text}-${row.lastUsedAt}`} value={row.text} className="bg-slate-900">
                  {alreadyActive ? `${row.text} (active)` : row.text}
                </option>
              );
            })}
          </select>
          <input
            className="h-11 rounded-xl border border-borderSoft/80 bg-panel px-3 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-accent/60 focus:ring-2 focus:ring-accent/15 disabled:opacity-50"
            value={draft}
            disabled={saving}
            maxLength={280}
            placeholder="New focus text"
            onChange={(event) => {
              setDraft(event.target.value);
              if (event.target.value) setSelectedHistoryText("");
            }}
            onKeyDown={handleDraftKeyDown}
          />
          <button
            type="submit"
            disabled={saving}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-accent/40 bg-accent/15 px-4 text-sm font-medium text-accent transition hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            Add
          </button>
        </form>
        {message && (
          <p className={`text-xs ${message.tone === "danger" ? "text-danger" : "text-slate-400"}`}>
            {message.text}
          </p>
        )}
      </div>
    </section>
  );
}
